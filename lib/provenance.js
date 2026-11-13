/**
 * Tool provenance: which installed package registers which tool.
 *
 * WHY THIS EXISTS. The live tool registry stores no ownership at all:
 * `dsh-tools` does `layer.tools.insert(name, definition)` and a definition is
 * only `{name, description, parameters, output, timeoutMs}`. Nothing in the
 * running composition can answer "who registered `terminal_open`". A panel that
 * wants to group tools BY SOURCE therefore has to derive it from the packages
 * that are loaded, which is what this module does: it reads each bundle's own
 * JavaScript and collects the names its `tools.register()` calls declare.
 *
 * WHAT IT DOES NOT CLAIM. Some tools are registered at runtime with a name built
 * from a variable (`subagent`, `workflow`, the `ops_*` family), so no static scan
 * can see them. Those land in `unknown` — they are never guessed at. A second,
 * looser rule ("the name is spelled somewhere in a registering file") was
 * measured and REJECTED: on a hand-checked fixture set it attributed 0 names
 * correctly and 1 wrongly, while the literal rule got 14/14 with no errors.
 * Precision matters more than recall here: a wrong owner in the panel is worse
 * than an unattributed tool.
 *
 * Cost, measured on this machine: ~1.3–3.5 s for the whole scan (6.6k candidate
 * files). Too slow to repeat per panel open, so the result is cached on disk
 * beside this package, keyed on the bucket-scheme version + the profile path +
 * the archive scanned + the installed package set. Installing or upgrading any
 * bundle invalidates it; an MCP server connecting does not. The profile and
 * archive belong in the key because this package is a shared `link:` directory:
 * without them, a no-archive (CLI/test) scan whose answer lacks every builtin
 * could be read back as the Electron host's.
 *
 * Pure node: no host imports, so it is unit-testable with node alone.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Where the cached scan lives, beside this package. */
const CACHE_FILE = 'provenance-cache.json'

/** How long a disk cache stays believable. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Bump when {@link OWNER_GROUPS} ids or the `groupOf` mapping change, so every
 * cached scan is re-derived rather than served under a bucket that no longer
 * exists. Stored inside the cache key, so an old file simply stops matching.
 */
const SCHEME_VERSION = '2'

/**
 * The buckets this machine can actually prove, plus the honest leftovers.
 *
 * The split rests on two verifiable facts, never a guess about a tool's purpose:
 * WHERE the registering code was found (inside app.asar = shipped with the app)
 * and the OWNING package's npm scope (@deepseek-ai = the vendor that publishes
 * the app itself, @local = this machine's own link: packages). Everything else
 * installed into the profile is a third-party bundle.
 */
export const OWNER_GROUPS = {
  builtin: '应用自带',
  official: '官方插件',
  thirdparty: '第三方插件',
  local: '本地自研插件',
  mcp: 'MCP 服务',
  unknown: '来源未识别',
}

/**
 * Which bucket an owning package belongs to.
 * @param {string} owner - package name as found on disk.
 * @param {boolean} fromAsar - whether its code was read out of app.asar.
 * @returns {string} a key of {@link OWNER_GROUPS}.
 */
export function groupOf(owner, fromAsar) {
  if (typeof owner === 'string' && owner.startsWith('@local/')) return 'local'
  // A shipped file is the app itself regardless of scope; only a profile copy of
  // an official package is an installed plugin.
  if (fromAsar === true) return 'builtin'
  if (typeof owner === 'string' && owner.startsWith('@deepseek-ai/')) return 'official'
  return 'thirdparty'
}

/**
 * Resolve the app.asar this process is running from.
 * @returns {string | undefined} the archive path, or undefined when not packaged.
 */
export function asarPath() {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'app.asar'))
  }
  // A dev/CLI host: walk up looking for a resources/app.asar.
  try {
    let dir = process.cwd()
    for (let step = 0; step < 6; step += 1) {
      candidates.push(path.join(dir, 'resources', 'app.asar'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* no cwd, no walk */
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Package name a file path belongs to, from its nearest node_modules segment.
 * @param {string} file - any path with forward or back slashes.
 * @returns {string} the package name, or 'unknown'.
 */
function ownerOf(file) {
  const normalised = String(file).replace(/\\/g, '/')
  const marker = normalised.lastIndexOf('/node_modules/')
  if (marker < 0) return 'unknown'
  const parts = normalised.slice(marker + '/node_modules/'.length).split('/')
  if (parts[0] === '@deepseek-ai') return `@deepseek-ai/${parts[1] ?? ''}`
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0]
}

/**
 * Whether a path is a package's own code (`lib`, `dist` or `src`), not a
 * dependency or a doc. Registrations were found at every depth here:
 * `lib/index.js`, `lib/types/tools.js`, `lib/shells/…`, so a single-level glob
 * would miss the nested ones.
 * @param {string[]} afterPackage - path segments following the package name.
 * @returns {boolean}
 */
function isPackageCode(afterPackage) {
  if (afterPackage.length < 2) return false
  if (afterPackage.some((segment) => segment === 'node_modules')) return false
  return afterPackage[0] === 'lib' || afterPackage[0] === 'dist' || afterPackage[0] === 'src'
}

/**
 * Read every shipped package's JavaScript out of an asar archive.
 *
 * The archive header is a JSON tree with byte offsets into the content region,
 * so only files that can contain a registration are read — no full extraction.
 * `unpacked: true` entries are native modules on disk, never tool definitions.
 * @param {string} archive - asar path.
 * @returns {Array<{file: string, owner: string, fromAsar: boolean, text: string}>}
 */
function readAsarLibraries(archive) {
  const out = []
  let fd
  try {
    fd = fs.openSync(archive, 'r')
    const header = Buffer.alloc(16)
    fs.readSync(fd, header, 0, 16, 0)
    const jsonSize = header.readUInt32LE(12)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) return out
    const jsonBuf = Buffer.alloc(jsonSize)
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
    const tree = JSON.parse(jsonBuf.toString('utf8').replace(/\0+$/, ''))
    const base = 16 + jsonSize
    const candidates = []
    const walk = (node, dir) => {
      for (const [name, meta] of Object.entries(node.files || {})) {
        const full = `${dir}/${name}`
        if (meta.files) {
          walk(meta, full)
          continue
        }
        if (!/\.js$/.test(full) || meta.unpacked === true) continue
        const normalised = full.replace(/\\/g, '/')
        const marker = normalised.lastIndexOf('/node_modules/')
        if (marker < 0) continue
        const rest = normalised.slice(marker + '/node_modules/'.length).split('/')
        const depth = rest[0].startsWith('@') ? 2 : 1
        if (!isPackageCode(rest.slice(depth))) continue
        candidates.push({ full, meta, owner: rest.slice(0, depth).join('/') })
      }
    }
    walk(tree, '')
    for (const entry of candidates) {
      const size = Number(entry.meta.size)
      if (!Number.isFinite(size) || size <= 0 || size > 3_000_000) continue
      const data = Buffer.alloc(size)
      fs.readSync(fd, data, 0, size, base + Number(entry.meta.offset))
      out.push({ file: entry.full, owner: entry.owner, fromAsar: true, text: data.toString('utf8') })
    }
  } catch {
    /* an unreadable archive contributes nothing */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
  return out
}

/**
 * Collect `.js`/`.mjs`/`.cjs` under a directory, skipping nested node_modules.
 * Depth- and size-bounded so a vendored tree cannot stall the scan.
 * @param {string} dir - directory to walk.
 * @param {Set<string>} into - receives absolute file paths.
 * @param {number} [depth] - internal recursion counter.
 */
function collectJs(dir, into, depth = 0) {
  if (depth > 4 || into.size > 400) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of entries) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (item.name !== 'node_modules') collectJs(full, into, depth + 1)
    } else if (/\.(c?js|mjs)$/.test(item.name)) {
      into.add(full)
    }
  }
}

/**
 * Read the profile's installed packages' own code.
 * @param {string} profileDir - the profile directory.
 * @returns {Array<{file: string, owner: string, fromAsar: boolean, text: string}>}
 */
function readProfileLibraries(profileDir) {
  const root = path.join(profileDir, 'node_modules')
  const out = []
  const packages = installedPackages(profileDir)
  for (const pkg of packages) {
    let dir = path.join(root, ...pkg.split('/'))
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) dir = fs.realpathSync(dir)
    } catch {
      /* keep the logical path */
    }
    const files = new Set()
    for (const sub of ['lib', 'dist', 'src']) collectJs(path.join(dir, sub), files, 0)
    for (const file of files) {
      try {
        if (fs.statSync(file).size > 3_000_000) continue
        out.push({ file, owner: pkg, fromAsar: false, text: fs.readFileSync(file, 'utf8') })
      } catch {
        /* unreadable */
      }
    }
  }
  return out
}

/**
 * The package names installed in a profile, which is also the cache key: any
 * install, removal or upgrade changes it.
 * @param {string} profileDir - the profile directory.
 * @returns {string[]} sorted package names.
 */
export function installedPackages(profileDir) {
  const root = path.join(profileDir, 'node_modules')
  const names = []
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return names
  }
  for (const item of entries) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue
    if (item.name === '.bin' || item.name === '.pnpm' || item.name === '.ds' || item.name.startsWith('.')) continue
    if (item.name.startsWith('@')) {
      const scopeDir = path.join(root, item.name)
      try {
        for (const scoped of fs.readdirSync(scopeDir)) names.push(`${item.name}/${scoped}`)
      } catch {
        /* unreadable scope */
      }
      continue
    }
    names.push(item.name)
  }
  return names.sort()
}

/**
 * The tool names a source file registers, read out of its register/defineTool
 * calls. Two shapes were observed in real bundles:
 *   ctx.tools.register(defineTool({ name: "x", ... }))
 *   ctx.tools.register({ name: "x", ... })
 * @param {string} text - file source.
 * @returns {string[]} tool names.
 */
export function toolsIn(text) {
  const names = new Set()
  const add = (value) => {
    if (typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value)) names.add(value)
  }
  for (const match of text.matchAll(/(?:tools\.register|defineTool)\(\s*\{?\s*\n?\s*name:\s*['"]([a-z0-9_]+)['"]/g)) add(match[1])
  // The multi-line form: the call body is scanned for its first `name:`.
  for (const match of text.matchAll(/tools\.register\(/g)) {
    const body = text.slice(match.index, match.index + 20_000)
    const named = body.match(/name:\s*['"]([a-z0-9_]+)['"]/)
    if (named !== null) add(named[1])
  }
  return [...names]
}

/**
 * Scan the machine for tool ownership.
 * @param {string} profileDir - the active profile directory.
 * @param {string | undefined} archive - app.asar path, resolved when omitted.
 * @returns {{literal: Record<string, {owner: string, group: string}>, scannedFiles: number}}
 */
export function scanProvenance(profileDir, archive = asarPath()) {
  const sources = [
    ...(archive === undefined ? [] : readAsarLibraries(archive)),
    ...readProfileLibraries(profileDir),
  ]
  const literal = {}
  for (const entry of sources) {
    if (!entry.text.includes('tools.register') && !entry.text.includes('defineTool')) continue
    const group = groupOf(entry.owner, entry.fromAsar)
    for (const name of toolsIn(entry.text)) {
      if (literal[name] === undefined) literal[name] = { owner: entry.owner, group }
    }
  }
  return { literal, scannedFiles: sources.length }
}

/**
 * The cache key: the installed package set PLUS the bucket scheme version.
 *
 * Any install, removal or upgrade changes the package part, so the panel never
 * shows a stale owner for a tool that moved packages — while an MCP server
 * connecting or a tool registering late does not, because neither changes what is
 * installed.
 *
 * The version part exists because a cached scan stores BUCKET IDS, not the facts
 * they were derived from. Renumbering or renaming {@link OWNER_GROUPS} in a new
 * release would otherwise keep serving rows tagged with a bucket that no longer
 * exists, and the panel would silently drop them. Bumping SCHEME_VERSION forces a
 * rescan instead.
 * @param {string} profileDir - the active profile directory.
 * @returns {string}
 */
export function cacheKey(profileDir, archive) {
  const parts = [
    SCHEME_VERSION,
    // The profile itself: this package is a shared `link:` directory, so two
    // profiles with an identical installed set must not read each other's scan.
    path.resolve(profileDir),
    // Whether the shipped archive was in reach AND which one: a plain-CLI or test
    // run has no `process.resourcesPath`, so its scan is missing every builtin.
    // Measured: such a run wrote a cache holding only `official,thirdparty`, and
    // the Electron host — same package set, same old key — accepted it, which
    // would have shown every shipped tool as "owner unknown" forever.
    archive === undefined ? 'no-archive' : path.resolve(archive),
    installedPackages(profileDir).join('|'),
  ]
  return parts.join('\n')
}

/**
 * Read a cached scan. Synchronous and cheap: the catalog serves whatever this
 * returns and never waits for a scan.
 * @param {string} cacheDir - where the cache file lives.
 * @param {string} key - the current {@link cacheKey}.
 * @returns {{scan: object, scannedAt: number} | undefined}
 */
export function readCache(cacheDir, key) {
  let cached
  try {
    cached = JSON.parse(fs.readFileSync(path.join(cacheDir, CACHE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (cached === null || typeof cached !== 'object') return undefined
  if (cached.key !== key || cached.scan === undefined) return undefined
  if (Date.now() - Number(cached.scannedAt ?? 0) >= CACHE_TTL_MS) return undefined
  return { scan: cached.scan, scannedAt: Number(cached.scannedAt) }
}

/**
 * Persist a scan.
 * @param {string} cacheDir - target directory.
 * @param {string} key - the {@link cacheKey} it was produced for.
 * @param {object} scan - from {@link scanProvenance}.
 * @returns {boolean} whether the write succeeded (a failure just means rescanning).
 */
export function writeCache(cacheDir, key, scan) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, CACHE_FILE), JSON.stringify({ key, scannedAt: Date.now(), scan }))
    return true
  } catch {
    return false
  }
}

/**
 * Assign every live tool name to an owning package and a group.
 *
 * MCP tools are handled by identity (`mcp__<server>__<tool>`): they are
 * registered at runtime by their server, so no source file can ever name them,
 * and the server is the real owner anyway. Everything the scan could not
 * attribute goes to `unknown` rather than being guessed.
 * @param {string[]} names - live tool names.
 * @param {Record<string, {owner: string, group: string}>} literal - from a scan.
 * @returns {Record<string, Array<{name: string, owner: string}>>} group -> tools.
 */
export function groupByOwner(names, literal) {
  const out = {}
  for (const group of Object.keys(OWNER_GROUPS)) out[group] = []
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    if (name.startsWith('mcp__')) {
      const server = name.slice(5).split('__')[0] ?? ''
      out.mcp.push({ name, owner: server === '' ? 'mcp' : `mcp:${server}` })
      continue
    }
    const hit = literal?.[name]
    if (hit === undefined) {
      out.unknown.push({ name, owner: '' })
      continue
    }
    ;(out[hit.group] ??= []).push({ name, owner: hit.owner })
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name))
  return out
}
