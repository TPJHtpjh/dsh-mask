/**
 * Provenance accuracy fixture — the permanent version of a hand-checked audit.
 *
 * The ownership buckets the masking panel shows are derived by scanning package
 * source for literal `tools.register(defineTool({ name: "x" }))` spellings. That
 * derivation can silently mis-attribute (a looser "name mentioned anywhere in a
 * registering file" rule once scored 0 correct / 1 WRONG against this same
 * fixture), so the known-correct answers are pinned here: if a future rule
 * change moves any of these names to a different owner, or starts claiming a
 * name that is registered at RUNTIME from a variable, this test fails.
 *
 * The fixture is this machine's real archive + profile, so it self-skips where
 * those paths do not exist (a clean CI box cannot answer "who registers
 * terminal_open" any better than a comment can).
 *
 * Run: node scripts/accuracy-fixture.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import { asarPath, groupOf, installedPackages, scanProvenance } from '../lib/provenance.js'

const PROFILE = process.env.DSH_PROFILE_DIR
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh/profiles/desktop')
const archive = asarPath() ?? process.env.DSH_APP_ASAR
if (archive === undefined || !fs.existsSync(archive) || installedPackages(PROFILE).length === 0) {
  console.log('SKIP: no app.asar or no profile packages on this machine')
  process.exit(0)
}

/**
 * Hand-verified from the registration source of each owning package.
 * `owner` = the package that spells the literal name in its register call;
 * `absent` = provably NOT statically reachable (built from a variable), so the
 * scan must not claim any owner for it at all.
 *
 * Two rows below were corrected by this test: an earlier draft guessed
 * `web_search` and `skill` belonged to third-party plugins, and the scan said
 * otherwise. Listing each owner's full claims showed the scan was right —
 * `@deepseek-ai/dsh-tool-web` registers web_search/web_fetch, the builtin
 * `dsh-tool-skill` registers `skill`, and `dsh-free-search` registers
 * weather/advanced_search/multi_search/research/... while skills-manager
 * registers only `create_skill`. That is the point of pinning verified answers.
 */
const KNOWN = {
  terminal_open: '@deepseek-ai/dsh-tool-terminal',
  terminal_send: '@deepseek-ai/dsh-tool-terminal',
  web_search: '@deepseek-ai/dsh-tool-web',
  skill: '@deepseek-ai/dsh-tool-skill',
  plugin_manager: '@deepseek-ai/dsh-plugin-manager',
  weather: 'dsh-free-search',
  advanced_search: 'dsh-free-search',
  research: 'dsh-free-search',
  automation_create: '@michengai/dsh-automation',
  automation_list: '@michengai/dsh-automation',
  create_skill: '@michengai/dsh-skills-manager',
  generate_image: 'dsh-image-gen',
  edit_image: 'dsh-image-gen',
  memory_search: 'dsh-prime-memory',
  memory_slot_write: 'dsh-prime-memory',
  dsh_code_review: '@michengai/dsh-code-review',
  pua_reference: '@michengai/dsh-pua',
}
const ABSENT = [
  'ops_bash', 'ops_glob', 'ops_grep', 'ops_read_files',
  'subagent', 'subagent_fork', 'workflow',
  'exit_plan_mode', 'context_compression_retrieve',
]

const scan = scanProvenance(PROFILE, archive)
/**
 * Is this owner present on this machine at all? Neither `installedPackages` nor
 * a hardcoded archive list can answer it: archive-owned packages (`@deepseek-ai/
 * dsh-tool-*`) never appear in the profile's node_modules, while a profile plugin
 * may be uninstalled at any time. The scan itself is the ground truth — if NO
 * name it found is attributed to this owner, the package isn't here, and asserting
 * a specific attribution would fail on every environment change rather than on a
 * rule regression.
 */
const ownersPresent = new Set(Object.values(scan.literal).map((entry) => entry.owner))
let failures = 0
let skipped = 0
for (const [name, owner] of Object.entries(KNOWN)) {
  const hit = scan.literal[name]
  if (!ownersPresent.has(owner)) {
    skipped += 1
    console.log(`skip ${name}: ${owner} is not on this machine`)
    continue
  }
  if (hit?.owner !== owner) {
    failures += 1
    console.log(`FAIL ${name}: expected owner ${owner}, got ${hit?.owner ?? '(absent)'}`)
  } else {
    console.log(`ok   ${name} -> ${owner} [${hit.group}]`)
  }
}
for (const name of ABSENT) {
  const hit = scan.literal[name]
  if (hit !== undefined) {
    failures += 1
    console.log(`FAIL ${name}: registered at RUNTIME from a variable; claiming owner ${hit.owner} is exactly the mis-attribution this fixture exists to catch`)
  } else {
    console.log(`ok   ${name} -> correctly not claimed`)
  }
}
// The bucket function itself, on the real owners.
const bucketChecks = [
  ['@deepseek-ai/dsh-tool-terminal', true, 'builtin'],
  ['dsh-free-search', false, 'thirdparty'],
  ['@michengai/dsh-automation', false, 'thirdparty'],
  ['@local/dsh-favorites', false, 'local'],
]
for (const [owner, fromAsar, want] of bucketChecks) {
  const got = groupOf(owner, fromAsar)
  if (got !== want) {
    failures += 1
    console.log(`FAIL groupOf(${owner}, fromAsar=${fromAsar}): ${got} != ${want}`)
  } else {
    console.log(`ok   groupOf(${owner}, fromAsar=${fromAsar}) = ${got}`)
  }
}
console.log(`\n${failures === 0 ? `provenance accuracy holds (${skipped} skipped: package not installed)` : `${failures} accuracy failures`}`)
if (failures > 0) process.exitCode = 1
