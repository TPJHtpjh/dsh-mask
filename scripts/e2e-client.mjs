/**
 * End-to-end proof of the client half, executed for real — not a string scan.
 *
 * Loads the installed `lib/client.js` the way the page does: a fake
 * `window.__ModuleLoader__` collects the registration, then the factory is
 * materialized with a module table that seeds only `react`, exactly like the
 * platform seed. `apply` runs against a recording context, and the panel is
 * rendered repeatedly with a STATEFUL fake React (hook slots survive, setters
 * write), so checkboxes can actually be ticked, sections collapsed and a save
 * driven through the real controller.
 *
 * The panel renders the host's RESOLVED rules (`catalog.stored`), so the closure
 * property asserted here is the one that matters: what the boxes show, saved
 * through the panel's own write path, must reproduce exactly those rules when the
 * host re-reads the config — using the real `toRulesConfig`/`buildRules`, not a
 * copy of them. scripts/roundtrip-proof.mjs runs the multi-case version.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { toRulesConfig } from '../lib/index.js'
import { buildRules, rulesFor } from '../lib/rules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const CLIENT_FILE = join(ROOT, 'lib', 'client.js')

const checks = []
/** Run one check now, or queue it when it needs the awaited save round-trip. */
const pending = []
const check = (label, fn) => {
  try {
    const result = fn()
    if (result instanceof Promise) {
      pending.push(result.then(
        () => checks.push({ ok: true, label }),
        (error) => checks.push({ ok: false, label, error }),
      ))
      return
    }
    checks.push({ ok: true, label })
  } catch (error) {
    checks.push({ ok: false, label, error })
  }
}

/* ── 1. Load the file through a page-shaped module loader ────────────────── */

/**
 * A recording timer. The panel schedules a re-read while the Host's provenance
 * scan is in flight; without a timer fake that effect is invisible, and the
 * "does it keep polling after a bundle install" question cannot be answered.
 */
const timers = []
const setTimeoutFake = (fn, delay) => {
  const entry = { fn, delay, cleared: false }
  timers.push(entry)
  return entry
}
const clearTimeoutFake = (entry) => {
  if (entry !== undefined && entry !== null) entry.cleared = true
}

/**
 * The route answer the panel fetches. Production reads the Host's inventory
 * route; a test swaps this to stand in for it. It lives in the vm context
 * because the panel code runs THERE — a `globalThis.fetch` in this module would
 * never be seen by the panel.
 */
let fetchImpl = undefined

/**
 * A stand-in for the real `Response` the panel reads: `status` plus `text()`
 * (production parses the body itself, so a stub with only `json()` would hide
 * the plain-text-404 path entirely).
 * @param {object} body - JSON answer served with status 200.
 * @returns {object} a fake response.
 */
const response = (body) => ({
  status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
})

/** A fake response for a non-JSON answer, like the server's generic 404. */
const textResponse = (status, text) => ({
  status,
  text: async () => text,
  json: async () => { throw new SyntaxError(`Unexpected token 'o', "${text}" is not valid JSON`) },
})

const registrations = []
const window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registrations.push({ id, factory })
    },
  },
}
const context = vm.createContext({
  window,
  console,
  setTimeout: setTimeoutFake,
  clearTimeout: clearTimeoutFake,
  // The panel reads `fetch` from its own realm, so the swap has to live here.
  fetch: (...args) => (fetchImpl === undefined ? Promise.reject(new Error('no fetch stub')) : fetchImpl(...args)),
})
vm.runInContext(readFileSync(CLIENT_FILE, 'utf8'), context, { filename: CLIENT_FILE })

check('client.js registers exactly one factory', () => assert.equal(registrations.length, 1))
check('factory id equals the package name', () => assert.equal(registrations[0].id, PKG.name))

/* ── 2. Materialize the factory with the platform seed only ──────────────── */

/**
 * A stateful fake React: hooks live in a per-render slot array so a component can
 * be re-rendered after its setters ran, which is what makes the checkbox and
 * collapse round-trips assertable at all (a stateless stub only proves "does not
 * throw").
 */
let hookSlots = []
let hookCursor = 0
/** Effects that ran, so a check can assert that a timer was scheduled. */
const effectsRan = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    // Capture the slot array NOW: the module global is reassigned by every
    // renderWith, and async checks interleave at their awaits. A setter that read
    // the global at call time would write state into whichever test happened to
    // render last — which is exactly how a busy `saving` state leaked across the
    // prefix check's renders.
    const slots = hookSlots
    const index = hookCursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
    }
    return [slots[index], setter]
  },
  // Effects really run, and their cleanup is kept: the panel schedules its
  // re-read poll inside an effect, so a no-op `useEffect` would hide every
  // timing behaviour this panel has.
  useEffect: (fn, deps) => {
    const entry = { fn, deps, cleanup: undefined }
    effectsRan.push(entry)
    entry.cleanup = fn()
    return () => { if (typeof entry.cleanup === 'function') entry.cleanup() }
  },
  useCallback: (fn) => fn,
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
  useMemo: (fn) => fn(),
  useRef: (value) => {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
}
/** Render one component, keeping the live hook array so setters write into it. */
function renderWith(component, props, keepHooks) {
  hookSlots = keepHooks ?? []
  hookCursor = 0
  const tree = component(props)
  return { tree, hooks: hookSlots }
}

const requested = []
const require = (spec) => {
  requested.push(spec)
  if (spec === 'react') return React
  throw new Error(`client-modules: require("${spec}") missed the module table`)
}

let plugin
check('factory materializes and returns a plugin object', () => {
  plugin = registrations[0].factory(require)
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
})
check('every require() hit the platform seed', () => {
  assert.deepEqual(requested.filter((spec) => spec !== 'react'), [])
})
check('declared inject lists services that exist on the client', () => {
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'])
})

/* ── 3. Apply against a recording context ────────────────────────────────── */

const effects = []
const registers = []
const dicts = []
/**
 * What `ctx.configForms.get(ns)` answers, set per check. It starts undefined so a
 * test can never accidentally render the picker branch without deliberately
 * installing a form controller.
 */
let formsService = undefined
const ctx = {
  effect: (fn, label) => {
    const disposer = fn()
    effects.push({ label, disposer })
    return () => {}
  },
  locale: {
    register: (ns, table) => {
      dicts.push({ ns, locales: Object.keys(table) })
      return () => {}
    },
    bind: (ns) => (key) => `${ns}.${key}`,
    subscribe: () => () => {},
  },
  // Production injects the browser plugin context itself into the panel and the
  // panel resolves `ctx.get('configForms')`; mirroring that here is what makes
  // the render checks exercise the picker instead of the "no forms" fallback.
  get: (key) => {
    if (key === 'slots') return slots
    if (key === 'configForms') return formsService
    return undefined
  },
}
const slots = {
  inject: (key, callback) => {
    const disposer = callback()
    return disposer ?? (() => {})
  },
  register: (options, component) => {
    registers.push({ options, component })
    return () => {}
  },
}

check('apply() runs without throwing', () => {
  assert.doesNotThrow(() => plugin.apply(ctx))
})
check('dictionaries registered under the panel namespace', () => {
  assert.equal(dicts.length, 1)
  assert.equal(dicts[0].ns, 'cherry-toolfilter')
  assert.deepEqual(dicts[0].locales.sort(), ['en', 'zh'])
})
check('two slots registered: the page and the icon', () => assert.equal(registers.length, 2))

const bySlot = Object.fromEntries(registers.map((r) => [r.options.name, r.options]))
check('the icon registers on sidebar.panellist with a string id', () => {
  assert.ok(bySlot['sidebar.panellist'], 'sidebar.panellist registration missing')
  assert.equal(typeof bySlot['sidebar.panellist'].id, 'string')
  assert.ok(bySlot['sidebar.panellist'].id.length > 0)
})
check('the page registers on main under the same key', () => {
  assert.ok(bySlot.main, 'main registration missing')
  assert.equal(bySlot.main.key, bySlot['sidebar.panellist'].id, 'the icon id and main key must match')
})
check('both registrations carry a locale namespace and a label thunk', () => {
  assert.equal(bySlot.main.locale, 'cherry-toolfilter')
  assert.equal(bySlot['sidebar.panellist'].locale, 'cherry-toolfilter')
  assert.equal(typeof bySlot['sidebar.panellist'].label, 'function')
})
check('the icon id is ours, not a shipped panel id being shadowed', () => {
  const shipped = ['plugins', 'schedules', 'dsh-market', 'dsh-context', 'dsh-favorites']
  assert.ok(!shipped.includes(bySlot['sidebar.panellist'].id))
})
check('the page receives its props through a factory, not a captured ctx', () => {
  assert.equal(typeof bySlot.main.inject, 'function')
})

const icon = registers.find((r) => r.options.name === 'sidebar.panellist').component
const page = registers.find((r) => r.options.name === 'main').component
check('icon component renders', () => {
  assert.ok(icon({ size: 20, active: false }))
})

/* ── 4. The picker, driven for real ──────────────────────────────────────── */

/** Every element in a fake-React tree, depth first. */
function flatten(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const entry of node) flatten(entry, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  flatten(node.children, out)
  return out
}

/** All rendered text of a fake-React tree, joined. The fake locale binder
 *  echoes `ns.key`, so dictionary keys are what match here. */
function collectText(tree) {
  return flatten(tree)
    .map((entry) => (Array.isArray(entry.children) ? entry.children.filter((c) => typeof c === 'string').join('') : ''))
    .join(' ')
}

/** A catalog shaped exactly like lib/index.js `readCatalog` returns. */
const CATALOG = {
  ok: true,
  ownerGroups: [
    { id: 'builtin', label: '应用自带' },
    { id: 'official', label: '官方插件' },
    { id: 'thirdparty', label: '第三方插件' },
    { id: 'local', label: '本地自研插件' },
    { id: 'mcp', label: 'MCP 服务' },
    { id: 'unknown', label: '来源未识别' },
  ],
  provenance: { scannedAt: 1, scanning: false },
  skillSources: [{ id: 'bundled', label: '插件自带的技能' }],
  presets: ['cherry', 'ptc'],
  // The host's RESOLVED rules — baseline folding and legacy fields already applied.
  stored: {
    cherry: {
      tools: { deny: ['terminal_open', 'terminal_list'], denyPrefix: ['mcp__github__'] },
      skills: { denyNames: [], denyProviders: [], denySources: ['bundled'] },
    },
  },
  mcpServers: ['github'],
  sealedBy: { 'session-1': ['terminal_open', 'terminal_list'] },
  tools: [
    { name: 'terminal_open', description: 'open a pty', group: 'builtin', owner: '@deepseek-ai/dsh-tool-terminal' },
    { name: 'terminal_list', description: 'list ptys', group: 'builtin', owner: '@deepseek-ai/dsh-tool-terminal' },
    { name: 'weather', description: 'forecast', group: 'thirdparty', owner: 'dsh-free-search' },
    { name: 'video_search', description: 'find videos', group: 'thirdparty', owner: 'dsh-free-search' },
    { name: 'mystery_tool', description: '', group: 'unknown', owner: '' },
  ],
  skills: [{ name: 'code', description: 'coding workflow', provider: 'bundled', source: 'bundled' }],
}

/** Build an isolated controller recording the write, so checks cannot race. */
function makeForm(value, options = {}) {
  const controller = {
    getSnapshot: () => (options.snapshot !== undefined
      ? options.snapshot
      : { status: 'ready', writable: true, revision: 3, value, base: {}, user: {} }),
    mutate: (ops, revision) => {
      controller.ops = ops
      controller.revision = revision
      if (options.throws === true) return Promise.reject(new Error('settings service exploded'))
      return Promise.resolve(options.reject === true ? false : true)
    },
    subscribe: () => () => {},
    ops: null,
  }
  return controller
}
/** The presets payload a controller was last asked to write. */
const presetsOf = (controller) => (controller.ops ?? []).find((op) => String(op.path?.[0]) === 'presets')?.value
/** The recorded op for one top-level path. */
const opFor = (controller, key) => (controller.ops ?? []).find((op) => String(op.path?.[0]) === key)

/**
 * Render the panel. `catalog` is the host's answer (null = route unavailable);
 * `hooks` carries the draft across renders, exactly like React does.
 * `owned` renders WITHOUT an injected catalog — the production shape, where this
 * half fetches the route itself and therefore owns the "re-read" affordances.
 */
function renderPanel(catalog = CATALOG, hooks, controller, owned = false) {
  const effective = controller ?? makeForm({})
  formsService = { get: (ns) => (ns === 'cherry-toolfilter' ? effective : undefined) }
  const props = { ...bySlot.main.inject(), useSyncExternalStore: React.useSyncExternalStore }
  if (owned === false) props.catalog = catalog
  const view = renderWith(page, props, hooks)
  return { ...view, controller: effective }
}

const sectionsOf = (tree) => flatten(tree).filter((n) => Array.isArray(n.props?.rows))
const checkRows = (tree) => sectionsOf(tree).flatMap((s) => s.props.rows)
const saveButton = (tree) => flatten(tree).filter((n) => n.type === 'button')
  .find((n) => /save|保存/i.test(String(n.children.flat().join(''))))
/** Toggle one row through the section's own handler, by DISPLAY name. */
function toggleRow(tree, name, on) {
  for (const section of sectionsOf(tree)) {
    const row = section.props.rows.find((entry) => entry.name === name)
    if (row !== undefined) {
      section.props.onToggle(row.store ?? name, on)
      return true
    }
  }
  return false
}

check('page component renders with no controller available yet', () => {
  formsService = undefined
  assert.ok(renderWith(page, { ...bySlot.main.inject() }, []).tree)
})

check('the panel degrades when the settings client is not mounted', () => {
  formsService = undefined
  const { tree } = renderWith(page, { ...bySlot.main.inject(), catalog: CATALOG }, [])
  const text = flatten(tree).map((entry) => String(entry.children.flat().join(''))).join(' ')
  assert.match(text, /noForms/, 'expected the no-forms notice')
  assert.equal(sectionsOf(tree).length, 0, 'nothing may be editable without the settings client')
})

check('page component renders with a live form controller', () => {
  const { tree } = renderPanel()
  assert.ok(tree)
  assert.ok(sectionsOf(tree).length > 0, 'a controller must produce an editable picker')
})

check('the picker lists real tools, not a JSON box', () => {
  const { tree } = renderPanel()
  const names = checkRows(tree).map((row) => row.name)
  assert.ok(names.length >= 6, `expected the inventory as checkboxes, got ${names.length}`)
  for (const expected of ['terminal_open', 'weather', 'mystery_tool', 'code', 'github', 'bundled']) {
    assert.ok(names.includes(expected), `${expected} is not offered as a checkbox`)
  }
  assert.deepEqual(flatten(tree).filter((entry) => entry.type === 'textarea'), [], 'the panel must not expose a raw JSON editor')
})

check('tools are grouped by the package that registers them', () => {
  const { tree } = renderPanel()
  const titles = sectionsOf(tree).map((s) => s.props.title)
  assert.ok(titles.includes('@deepseek-ai/dsh-tool-terminal'), `no owner-headed section in ${titles.join(' | ')}`)
  assert.ok(titles.includes('dsh-free-search'), 'an installed plugin is its own section')
  // An unattributable tool gets its own bucket rather than being hidden or
  // guessed at. The fake locale binder returns `ns.key`, so that is what shows.
  assert.ok(titles.some((title) => /bucketUnknown/.test(title)), `the unknown bucket is missing from ${titles.join(' | ')}`)
})

check('stored rules come back as checked boxes', () => {
  const rows = checkRows(renderPanel().tree)
  const checked = rows.filter((row) => row.checked === true).map((row) => row.name).sort()
  assert.deepEqual(checked, ['bundled', 'github', 'terminal_list', 'terminal_open'])
  assert.ok(rows.filter((row) => row.checked !== true).map((row) => row.name).includes('weather'), 'an unconfigured tool must be offered unchecked')
})

check('a rule naming an unenumerated tool stays visible and checked', () => {
  const catalog = {
    ...CATALOG,
    stored: { cherry: { tools: { deny: ['gone_tool'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } } },
  }
  const rows = checkRows(renderPanel(catalog).tree)
  const row = rows.find((entry) => entry.name === 'gone_tool')
  assert.ok(row !== undefined, 'an orphan rule must still be listed')
  assert.equal(row.checked, true)
})

check('the save button is disabled while the draft matches what is stored', () => {
  const save = saveButton(renderPanel().tree)
  assert.ok(save !== undefined, 'no save button rendered')
  assert.equal(save.props.disabled, true)
})

check('ticking a box round-trips into the draft and unlocks save', async () => {
  const first = renderPanel()
  assert.equal(checkRows(first.tree).find((row) => row.name === 'weather').checked, false)
  assert.equal(toggleRow(first.tree, 'weather', true), true)
  const second = renderPanel(CATALOG, first.hooks, first.controller)
  assert.equal(checkRows(second.tree).find((row) => row.name === 'weather').checked, true, 'the tick did not reach the draft')
  assert.equal(saveButton(second.tree).props.disabled, false, 'save stayed locked after a real change')
  await saveButton(second.tree).props.onClick()
  const presets = presetsOf(second.controller)
  assert.equal([...presets.cherry.tools.deny].sort().join(','), 'terminal_list,terminal_open,weather')
})

check('unticking a stored box removes it from the saved rules', async () => {
  const first = renderPanel()
  assert.equal(checkRows(first.tree).find((row) => row.name === 'terminal_open').checked, true)
  toggleRow(first.tree, 'terminal_open', false)
  const second = renderPanel(CATALOG, first.hooks, first.controller)
  assert.equal(checkRows(second.tree).find((row) => row.name === 'terminal_open').checked, false)
  await saveButton(second.tree).props.onClick()
  const presets = presetsOf(second.controller)
  assert.ok(!presets.cherry.tools.deny.includes('terminal_open'), 'an unticked stored rule must actually go away')
  assert.ok(presets.cherry.tools.deny.includes('terminal_list'), 'the other rules must survive')
})

check('saving pins defaults:false and clears the legacy fields', async () => {
  // Unsetting `defaults` would let the baseline fold back in on the next read,
  // and leaving `presetId`/`deny` in the row makes toRulesConfig re-merge them, so
  // an untick would do nothing. Both are closure breaks, not style choices.
  const first = renderPanel()
  toggleRow(first.tree, 'terminal_open', false)
  const second = renderPanel(CATALOG, first.hooks, first.controller)
  await saveButton(second.tree).props.onClick()
  const defaults = opFor(second.controller, 'defaults')
  // The op object crosses the vm realm, so compare fields, not deep-equality.
  assert.equal(defaults?.op, 'set', 'defaults must be pinned, not unset')
  assert.equal(defaults?.value, false, 'defaults must be pinned FALSE, not left implicit')
  assert.equal(opFor(second.controller, 'presetId')?.op, 'unset', 'the legacy presetId must be cleared')
  assert.equal(opFor(second.controller, 'deny')?.op, 'unset', 'the legacy deny list must be cleared')
})

check('unchecking everything in cherry stores an explicit empty list the engine honours', async () => {
  // Each toggle re-renders: the draft lives in hook state, and a second toggle
  // driven off the previous tree would compute from a stale pick.
  let view = renderPanel()
  for (const name of ['terminal_open', 'terminal_list', 'github', 'bundled']) {
    toggleRow(view.tree, name, false)
    view = renderPanel(CATALOG, view.hooks, view.controller)
  }
  await saveButton(view.tree).props.onClick()
  const presets = presetsOf(view.controller)
  // Compare as strings: the payload crosses the vm realm, so its Array prototype
  // differs and deepEqual fails on identity rather than content.
  assert.equal(presets.cherry.tools.deny.join('|'), '', 'an emptied selection must stay empty')
  // The host must agree: nothing hidden, baseline not resurrected.
  const written = { defaults: false, presets }
  const effective = rulesFor(buildRules(toRulesConfig(written)), 'cherry')
  assert.equal(effective.tools.deny.length, 0, `the engine hides ${effective.tools.deny.length} tools after "uncheck everything"`)
  assert.equal(effective.skills.denySources.length, 0, 'skill rules must be emptied too')
})

check('a saved draft re-reads clean through the host resolver', async () => {
  // The strongest single closure property: take what the panel wrote, hand it to
  // the host, and the resolved rules must equal what the boxes showed. If they do
  // not, a second save would change behaviour the user never asked for.
  const first = renderPanel()
  const shownTools = checkRows(first.tree)
    .filter((row) => row.checked === true && row.locked !== true && CATALOG.tools.some((t) => t.name === row.name))
    .map((row) => row.name)
  toggleRow(first.tree, 'weather', true)
  const second = renderPanel(CATALOG, first.hooks, first.controller)
  await saveButton(second.tree).props.onClick()
  const written = { defaults: false, presets: presetsOf(second.controller) }
  const resolved = buildRules(toRulesConfig(written))
  const hidden = rulesFor(resolved, 'cherry').tools.deny
  const expected = [...shownTools, 'weather'].sort()
  assert.equal([...hidden].sort().join(','), expected.join(','), `host hides ${hidden.join(',')} but boxes said ${expected.join(',')}`)
  // And re-rendering with the host's new answer must be un-dirty.
  const reread = renderPanel({ ...CATALOG, stored: storedOf(resolved) })
  assert.equal(saveButton(reread.tree).props.disabled, true, 'the saved config re-reads as an edit (not idempotent)')
})

check('a rejected save drops the draft back to the host truth, not the refused ticks', async () => {
  // The notice promised "the stored value was re-read" while the code kept the
  // edited draft: the write was refused, so the host's `stored` never changed,
  // the `storedKey` re-sync effect never fired, and the boxes kept ticks the
  // deployment rejected — the NEXT save would re-send them. Now the rejection
  // branch resets the draft itself.
  const controller = makeForm({}, { reject: true })
  const first = renderPanel(CATALOG, undefined, controller)
  toggleRow(first.tree, 'weather', true)
  const second = renderPanel(CATALOG, first.hooks, controller)
  await saveButton(second.tree).props.onClick()
  // Drain the awaited mutate + setDraft.
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const third = renderPanel(CATALOG, second.hooks, controller)
  const row = checkRows(third.tree).find((entry) => entry.name === 'weather')
  assert.ok(row !== undefined, 'weather row vanished after a rejected save')
  assert.notEqual(row.checked, true, 'the refused tick survived the rejection')
  // The dirty badge must be gone: the draft equals the host's answer again.
  const text = flatten(third.tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.doesNotMatch(text, /dirty/, 'the panel still reports unsaved changes after rejecting the write')
})

check('a save whose mutate() rejects does not freeze the panel on saving', async () => {
  // `mutate()` can REJECT, not only return false. The old code awaited it
  // outside any try: the rejection escaped before `setBusy(false)`, leaving
  // the button stuck on "saving…" with no retry, forever. A settings UI must
  // never enter that state.
  const controller = makeForm({}, { throws: true })
  const first = renderPanel(CATALOG, undefined, controller)
  toggleRow(first.tree, 'weather', true)
  const second = renderPanel(CATALOG, first.hooks, controller)
  await saveButton(second.tree).props.onClick()
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  const third = renderPanel(CATALOG, second.hooks, controller)
  const busy = flatten(third.tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.doesNotMatch(busy, /saving|保存中/, 'the panel stayed stuck in the saving state after a rejected mutate')
  // The draft fell back to the host truth, so a second save attempt is possible.
  const save = saveButton(third.tree)
  assert.ok(save !== undefined, 'no save affordance after the failure')
})

check('the settings read still in flight is a wait, not a read-only verdict', () => {
  // The snapshot vocabulary was READ OUT of dsh-client-ui-settings, not
  // guessed: `loading` ships value/base/user/revision as undefined AND a
  // PLACEHOLDER `writable: false`. The old gate `writable !== false` treated
  // that placeholder as the deployment's policy: the picker was disabled and
  // the panel told the user "this deployment is read-only" — a lie about a
  // state that fixes itself in one round-trip. The checkboxes come from the
  // catalog's `stored`, so they must stay usable while only saving waits.
  const loading = { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }
  const controller = makeForm({}, { snapshot: loading })
  const { tree } = renderPanel(CATALOG, undefined, controller)
  const text = flatten(tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.doesNotMatch(text, /readOnly/, 'an in-flight settings read was reported as a read-only deployment')
  assert.match(text, /formPending/, 'the wait is not explained as a wait')
  // The list is usable: rows render and none is disabled by the placeholder.
  const rows = checkRows(tree)
  assert.ok(rows.length > 0, 'the picker was disabled while the settings read was in flight')
  // Saving waits for the revision.
  assert.equal(saveButton(tree).props.disabled, true, 'saving was allowed without a revision')
})

/** The resolved rule map in the shape the catalog serves it. */
function storedOf(rules) {
  const out = {}
  for (const [id, entry] of rules) {
    out[id] = {
      tools: { deny: [...entry.tools.deny], denyPrefix: [...entry.tools.denyPrefix] },
      skills: {
        denyNames: [...entry.skills.denyNames],
        denyProviders: [...entry.skills.denyProviders],
        denySources: [...entry.skills.denySources],
      },
    }
  }
  return out
}

check('bulk select cannot materialise wildcard names into the current mode', async () => {
  // The rows `*` hides render checked-and-locked, and one click on a locked box
  // does nothing — but a bulk "select all" that walked the SAME rows would copy
  // those names into this mode's own list. Invisible today (already hidden),
  // wrong tomorrow: remove the rule from `*` and this mode keeps hiding names the
  // user never picked here.
  const catalog = {
    ...CATALOG,
    stored: {
      '*': { tools: { deny: ['weather'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
      cherry: { tools: { deny: ['terminal_open'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
    },
  }
  const first = renderPanel(catalog)
  // The dsh-free-search section holds both the wildcard-hidden `weather` (locked)
  // and the editable `video_search`, so select-all there is exactly the case where
  // walking all rows would leak.
  const group = sectionsOf(first.tree).find((s) => s.props.title === 'dsh-free-search')
  assert.ok(group !== undefined, 'the third-party section is missing')
  assert.equal(group.props.rows.length, 2, 'this section must hold both a locked and an editable row')
  const weather = checkRows(first.tree).find((row) => row.name === 'weather')
  assert.equal(weather.locked, true, 'the precondition changed: weather is not a wildcard-only row')
  group.props.onBulk(true)
  const second = renderPanel(catalog, first.hooks, first.controller)
  await saveButton(second.tree).props.onClick()
  const deny = presetsOf(second.controller).cherry.tools.deny
  assert.ok(deny.includes('video_search'), `select-all skipped the editable row of its own section: [${deny.join(',')}]`)
  assert.ok(!deny.includes('weather'), `wildcard-only name leaked into cherry: [${deny.join(',')}]`)
})

check('wildcard rules show as checked-but-locked in another mode', () => {
  const catalog = {
    ...CATALOG,
    stored: {
      '*': { tools: { deny: ['weather'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
      cherry: { tools: { deny: ['terminal_open'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
    },
  }
  const rows = checkRows(renderPanel(catalog).tree)
  const weather = rows.find((row) => row.name === 'weather')
  assert.equal(weather.checked, true, 'the wildcard hide is invisible in the mode view')
  assert.equal(weather.locked, true, 'the wildcard box was offered as if unticking it would work')
})

check('the same wildcard rule is editable while editing the wildcard view', () => {
  const catalog = {
    ...CATALOG,
    stored: {
      '*': { tools: { deny: ['weather'], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
      cherry: { tools: { deny: [], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
    },
  }
  const first = renderPanel(catalog)
  // Switch to the `*` view through the real chip.
  const chip = flatten(first.tree).find((n) => n.type === 'button' && String(n.children.flat().join('')) === '*')
  assert.ok(chip !== undefined, 'no way to reach the wildcard view')
  chip.props.onClick()
  const second = renderPanel(catalog, first.hooks, first.controller)
  const weather = checkRows(second.tree).find((row) => row.name === 'weather')
  assert.equal(weather.checked, true)
  assert.notEqual(weather.locked, true, 'in its own view a wildcard box must be editable')
})

check('clicking a section header collapses a section that opened by default', () => {
  // The reported bug: an `expanded` flag ORed with `defaultOpen` made the header's
  // `setOpen(!expanded)` always false, so any open section could never close.
  const { tree } = renderPanel()
  const terminal = sectionsOf(tree).find((s) => s.props.rows.some((row) => row.name === 'terminal_open'))
  assert.ok(terminal !== undefined, 'the terminal owner section is not rendered')
  // A Section is a function component, so drive it with its own hook slate: render,
  // click the header, render again with the state the click wrote.
  // Rows are CheckRow ELEMENTS (the fake React does not invoke them), so a rendered
  // row is recognised by its `checked` + `onChange` props, not by an `input`.
  const boxes = (node) => flatten(node).filter((n) => typeof n.props?.onChange === 'function' && typeof n.props?.checked === 'boolean')
  const scratch = []
  hookSlots = scratch
  hookCursor = 0
  const first = terminal.type(terminal.props)
  const header = flatten(first).find((n) => n.type === 'div' && typeof n.props?.onClick === 'function')
  assert.ok(header !== undefined, 'no clickable section header')
  assert.ok(boxes(first).length > 0, 'a default-open section renders no checkboxes')
  header.props.onClick()
  hookCursor = 0
  const second = terminal.type(terminal.props)
  assert.equal(boxes(second).length, 0, 'clicking the header did not collapse the section')
  assert.equal(flatten(second).filter((n) => n.type === 'button').length, 0, 'the bulk row survived the collapse')
  // And clicking again must re-open it: the flag is the user's, not sticky.
  const header2 = flatten(second).find((n) => n.type === 'div' && typeof n.props?.onClick === 'function')
  header2.props.onClick()
  hookCursor = 0
  assert.ok(boxes(terminal.type(terminal.props)).length > 0, 'a collapsed section could not be re-opened')
})

check('the panel owns its scroll instead of growing past the viewport', () => {
  // The shell clips the column, so a plain auto-height root becomes unscrollable.
  const { tree } = renderPanel()
  assert.equal(tree.props.style.height, '100%', 'the root must fill the column')
  assert.equal(tree.props.style.overflow, 'hidden', 'the root must clip and let an inner body scroll')
  const body = flatten(tree).find((n) => n.props?.style?.overflowY === 'auto')
  assert.ok(body !== undefined, 'no scrolling body element')
  assert.equal(String(body.props.style.flex).charAt(0), '1', 'the scrolling body must be the flexible child')
})

check('every unlocked row can be toggled through its own section', () => {
  const { tree } = renderPanel()
  const rows = checkRows(tree)
  assert.ok(rows.length >= 6)
  for (const row of rows) {
    assert.equal(typeof row.checked, 'boolean', `${row.name} has no checked state`)
    if (row.locked === true) continue
    // Look the row up by its DISPLAY name; toggleRow maps it to the stored key.
    assert.equal(toggleRow(tree, row.name, row.checked !== true), true, `${row.name} has no section handler`)
  }
})

check('bulk select fills a whole group and bulk clear empties it', () => {
  const first = renderPanel()
  const section = sectionsOf(first.tree).find((s) => s.props.rows.some((row) => row.name === 'terminal_open'))
  section.props.onBulk(true)
  const second = renderPanel(CATALOG, first.hooks, first.controller)
  const after = sectionsOf(second.tree).find((s) => s.props.rows.some((row) => row.name === 'terminal_open'))
  assert.ok(after.props.rows.every((row) => row.checked === true), 'select-all left something unchecked')
  after.props.onBulk(false)
  const third = renderPanel(CATALOG, second.hooks, second.controller)
  const cleared = sectionsOf(third.tree).find((s) => s.props.rows.some((row) => row.name === 'terminal_open'))
  assert.ok(cleared.props.rows.every((row) => row.checked !== true), 'select-none left something checked')
})

check('a catalog without resolved rules disables editing entirely', () => {
  // The data-loss case: a Host process still running an older build serves a
  // catalog with no `stored`, so the draft would start EMPTY and ticking one box
  // would write a config holding only that box — deleting every rule in force.
  const legacy = { ...CATALOG, stored: undefined }
  const { tree } = renderPanel(legacy)
  assert.equal(saveButton(tree).props.disabled, true, 'a catalog without `stored` was savable')
  const text = flatten(tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /staleHost/, 'the refusal is not explained as a stale host')
  // And no row may be offered as editable: the boxes cannot know the truth.
  const rows = checkRows(tree)
  assert.equal(rows.length, 0, `a stale host still offered ${rows.length} rows to edit`)
})

check('a plain-text 404 from the server reads as a missing route, not a JSON error', async () => {
  // The measured production failure: the host half never registered the route
  // (a startup-order race), the server answered its generic plain-text 404
  // `not found`, and `response.json()` surfaced the parser's complaint —
  // `Unexpected token 'o', "not found" is not valid JSON` — which names a JSON
  // problem while the real one (nobody registered the path; a restart fixes it)
  // went unexplained. The panel must recognize the 404 shape itself.
  fetchImpl = async () => textResponse(404, 'not found')
  let view
  try {
    const first = renderPanel(undefined, undefined, undefined, true)
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve()
      await Promise.resolve()
    }
    view = renderPanel(undefined, first.hooks, first.controller, true)
  } finally {
    fetchImpl = undefined
  }
  const text = flatten(view.tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /noRoute/, 'the missing route is not explained as a missing route')
  assert.doesNotMatch(text, /not valid JSON/, 'the raw parser complaint is still shown to the user')
  // Nothing editable, and the retry button still exists (a later host start
  // can make the route appear without a reload of the page).
  assert.equal(checkRows(view.tree).length, 0, 'rows were offered while the route is missing')
  const retry = flatten(view.tree).filter((n) => n.type === 'button')
    .find((n) => /retry|重新读取/.test(String(n.children.flat().join(''))))
  assert.ok(retry !== undefined, 'no retry affordance on the missing-route notice')
})

check('the host refusal code is mapped to this page language, never shown raw', async () => {
  // The host cannot know the page's language, so its 403 carries a machine
  // code. The panel must translate the code through its OWN dictionary —
  // showing `local-page-only` (or an old Chinese sentence) to an English UI
  // is the leak this pins.
  fetchImpl = async () => ({
    status: 403,
    text: async () => JSON.stringify({ ok: false, error: 'local-page-only', code: 'not-local' }),
  })
  let view
  try {
    const first = renderPanel(undefined, undefined, undefined, true)
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve()
      await Promise.resolve()
    }
    view = renderPanel(undefined, first.hooks, first.controller, true)
  } finally {
    fetchImpl = undefined
  }
  const text = flatten(view.tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /notLocal/, 'the refusal was not mapped to the panel dictionary')
  assert.doesNotMatch(text, /local-page-only|拒绝非本机/, 'a host string leaked into the UI untranslated')
})

check('raw (non-MCP) denyPrefix renders honest, survives save, unticks away', async () => {
  // A hand-authored `denyPrefix: ['automation_']` used to be dressed as an MCP
  // server row whose store key became `mcp__automation___`: the ACTIVE hide showed
  // UNCHECKED, could never be unticked, and any save silently dropped it — all
  // three breaking "the boxes are the truth". Reproduced live, then fixed with a
  // dedicated prefix section.
  const catalog = {
    ...CATALOG,
    stored: {
      cherry: { tools: { deny: [], denyPrefix: ['automation_'] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
    },
  }
  const first = renderPanel(catalog)
  const rows = checkRows(first.tree)
  const row = rows.find((entry) => entry.store === 'automation_')
  assert.ok(row !== undefined, 'the raw prefix rule is not listed under its own key')
  assert.equal(row.checked, true, 'an active prefix rule was shown unchecked')
  // An unrelated tick must carry the prefix through the write.
  toggleRow(first.tree, 'terminal_open', true)
  const second = renderPanel(catalog, first.hooks, first.controller)
  await saveButton(second.tree).props.onClick()
  assert.ok(presetsOf(second.controller).cherry.tools.denyPrefix.includes('automation_'), 'the prefix died in an unrelated save')
  // And unticking the prefix itself must remove it.
  const third = renderPanel(catalog, second.hooks, second.controller)
  toggleRow(third.tree, row.name, false)
  const fourth = renderPanel(catalog, third.hooks, third.controller)
  await saveButton(fourth.tree).props.onClick()
  assert.equal(presetsOf(fourth.controller).cherry.tools.denyPrefix.includes('automation_'), false, 'unticking the prefix did nothing')
})

check('the panel tells the user a source scan is still running', () => {
  // The host never blocks the catalog on the scan, so an early open legitimately
  // has every tool under "owner unknown". Saying so is what keeps that state from
  // reading as "this machine has no third-party tools".
  const scanning = { ...CATALOG, provenance: { scannedAt: 0, scanning: true } }
  const text = flatten(renderPanel(scanning).tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /scanning/, 'the in-flight scan is not announced')
  const settled = flatten(renderPanel(CATALOG).tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.doesNotMatch(settled, /scanning/, 'a finished scan still claims to be running')
})

check('explanatory prose is not the visual centre of the panel', () => {
  // The audit complaint: the header stacked the intro and the mode-explanation
  // paragraphs above the list, so the loudest thing on every open was text that
  // is read once. The head now carries only STATE (loading, errors, results);
  // the prose moved to a footnote below the list, still reachable, never central.
  const { tree } = renderPanel()
  const head = tree.children[0]
  const headText = flatten(head).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.doesNotMatch(headText, /intro/, 'the intro paragraph still opens the panel from the header')
  assert.doesNotMatch(headText, /modeHint/, 'the mode explanation still sits in the sticky header')
  assert.doesNotMatch(headText, /liveNone/, 'an always-on "no records" notice returned to the header')
  const bodyText = flatten(tree.children[1]).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(bodyText, /intro/, 'the explanation vanished entirely instead of moving to the footnote')
  assert.match(bodyText, /modeHint/, 'the mode note vanished instead of moving to the footnote')
})

check('every interactive element is hover-styled and keyboard reachable', () => {
  const { tree } = renderPanel()
  const buttons = flatten(tree).filter((n) => n.type === 'button')
  // Chips (cherry, ptc, 所有模式) + save. Bulk buttons live inside Sections and
  // are asserted below after rendering one.
  assert.ok(buttons.length >= 4, `expected mode chips and save; saw ${buttons.length}`)
  for (const button of buttons) {
    assert.equal(button.props.className, 'ct-clickable', `button "${String(button.children.flat().join(''))}" has no hover/focus class`)
  }
  const inputs = flatten(tree).filter((n) => n.type === 'input')
  assert.ok(inputs.length > 0)
  // Checkbox rows live inside the Section components, which the fake React does
  // not invoke on its own — run the sections, then run the CheckRow elements they
  // produced, to see the real `label` with its hover class. A section that opens
  // collapsed renders no rows, so scan for one that does.
  const saved = [hookSlots, hookCursor]
  let labels = []
  let bulk = []
  let rendered2 = []
  for (const sample of sectionsOf(tree)) {
    hookSlots = []
    hookCursor = 0
    const rendered = flatten(sample.type(sample.props))
    const rowElements = rendered.filter((n) => typeof n.type === 'function' && typeof n.props?.onChange === 'function' && typeof n.props?.checked === 'boolean')
    hookSlots = []
    hookCursor = 0
    labels = rowElements.flatMap((row) => flatten(row.type(row.props)).filter((n) => n.type === 'label'))
    bulk = rendered.filter((n) => n.type === 'button')
    if (labels.length > 0) {
      rendered2 = rendered
      break
    }
  }
  ;[hookSlots, hookCursor] = saved
  assert.ok(labels.length > 0, 'no section rendered any checkbox row')
  for (const label of labels) {
    assert.equal(label.props.className, 'ct-row', 'a checkbox row escaped the hover class')
  }
  assert.ok(bulk.length >= 2, 'the section lost its select-all/select-none shortcuts')
  for (const button of bulk) {
    assert.equal(button.props.className, 'ct-clickable', 'a bulk button has no hover/focus class')
  }
  const search = flatten(tree).find((n) => n.type === 'input' && n.props.placeholder !== undefined)
  assert.ok(search !== undefined && /ct-input/.test(search.props.className ?? ''), 'the search field has no focus style class')
  // A search input with only a placeholder is announced as "edit text"; the
  // label must exist for screen readers.
  assert.ok(search.props['aria-label'] !== undefined, 'the search field relies on placeholder alone')
  // Disclosure headers were divs with onClick: unreachable by keyboard. They too
  // live inside the Section components, so inspect what a section rendered.
  const heads = rendered2.filter((n) => n.props?.role === 'button' && n.props?.['aria-expanded'] !== undefined)
  assert.ok(heads.length === 1, `a section has no keyboard-operable disclosure (${heads.length})`)
  for (const head of heads) {
    assert.equal(head.props.tabIndex, 0)
    assert.equal(typeof head.props.onKeyDown, 'function', 'a disclosure ignores Enter/Space')
    assert.equal(typeof head.props.onClick, 'function')
  }
})

check('type scale respects the small-text floor', () => {
  // Craft: 11px is the practical floor for UI text; the old tag sat at 10px and
  // the whole panel at 12px. Buttons/rows must not fall below the floor either.
  const { tree } = renderPanel()
  const sizes = flatten(tree).map((n) => n.props?.style?.fontSize).filter((x) => typeof x === 'string')
  const px = (value) => Number.parseFloat(value)
  assert.ok(sizes.length > 10, 'styles barely reached the tree')
  const tooSmall = sizes.filter((value) => px(value) < 11 && value !== '11px')
  assert.equal(tooSmall.length, 0, `text under the 11px floor: ${tooSmall.join(',')}`)
  const h1 = flatten(tree).find((n) => n.type === 'h1')
  assert.ok(px(h1.props.style.fontSize) >= 15, `h1 at ${h1.props.style.fontSize} does not outrank 14px body`)
})

check('a long owner name truncates instead of pushing the counts away', () => {
  // The real installed set contains names like
  // `@deepseek-ai/dsh-experimental-tool-agent-team`; in a narrow panel an
  // unbreakable title evicted the "已屏蔽 n / 共 n" numbers, which are the whole
  // point of the header.
  const catalog = {
    ...CATALOG,
    tools: [
      ...CATALOG.tools,
      { name: 'team_task', description: '', group: 'builtin', owner: '@deepseek-ai/dsh-experimental-tool-agent-team' },
    ],
  }
  const { tree } = renderPanel(catalog)
  const sample = sectionsOf(tree).find((s) => s.props.title === '@deepseek-ai/dsh-experimental-tool-agent-team')
  assert.ok(sample !== undefined, 'the long-named owner section is missing')
  const saved = [hookSlots, hookCursor]
  hookSlots = []
  hookCursor = 0
  const rendered = flatten(sample.type(sample.props))
  ;[hookSlots, hookCursor] = saved
  const head = rendered.find((n) => n.props?.role === 'button')
  const title = head.children.find((n) => String(n.children.flat().join('')).includes('agent-team'))
  assert.equal(title.props.style.textOverflow, 'ellipsis', 'the owner title cannot truncate')
  const text = flatten(head).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /countTotal|共/, 'the total count disappeared from the header')
  const shrinkable = flatten(head).filter((n) => n.props?.style?.flexShrink === 0)
  assert.ok(shrinkable.length >= 3, 'counts and caret are still squeezable off-row')
})

check('an empty inventory says so instead of rendering nothing', () => {
  // A list that renders zero rows reads as a broken panel, not as "nothing here".
  const empty = { ...CATALOG, tools: [], skills: [], mcpServers: [], stored: {} }
  const { tree } = renderPanel(empty)
  const text = flatten(tree).map((n) => String(n.children.flat().join(''))).join(' ')
  assert.match(text, /toolsEmpty/, 'the empty inventory is not explained')
  // And it must not claim success: saving is still disabled with nothing to save.
  assert.equal(saveButton(tree).props.disabled, true)
})

check('the healthy panel can re-read the inventory on demand', () => {
  // The inventory is a snapshot of THIS machine: an MCP server that connects
  // later, or a plugin installed after the panel opened, only shows up after a
  // re-read. The button used to appear only in the ERROR state, so the
  // documented "read again" step did not exist while everything was fine.
  const { tree } = renderPanel(CATALOG, undefined, undefined, true)
  const buttons = flatten(tree).filter((n) => n.type === 'button')
  const reload = buttons.find((n) => /reload|重新读取清单/.test(String(n.children.flat().join(''))))
  assert.ok(reload !== undefined, 'a healthy panel offers no way to re-read the inventory')
  assert.equal(typeof reload.props.onClick, 'function', 'the re-read button does nothing')
})

check('a scan in flight keeps being polled even with an older result present', async () => {
  // Installing a bundle starts a NEW scan while the PREVIOUS result is still
  // served, so `scannedAt` is a non-zero old timestamp. The poll condition used
  // to require `scannedAt === 0`, which never fired in that case: the ownership
  // groups stayed frozen at the pre-install answer until a manual reload.
  //
  // The poll only exists when this half owns the route (production). In
  // production `props.catalog` stays undefined and the answer arrives through
  // fetch, so this renders the owned shape and lets the fetch land.
  const scanningWithOldResult = { ...CATALOG, provenance: { scannedAt: 1700000000000, scanning: true } }
  fetchImpl = async () => response(scanningWithOldResult)
  timers.length = 0
  try {
    const first = renderPanel(undefined, undefined, undefined, true)
    // The fetch resolves into state; re-render with the same hooks so the poll
    // effect sees the arrived catalog (production does this via React's own
    // scheduler). The number of microtask turns the promise chain needs is an
    // implementation detail, so drain until the catalog slot is filled rather
    // than counting turns.
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve()
      await Promise.resolve()
      const slot = first.hooks[0]
      if (slot !== null && slot !== undefined) break
    }
    renderPanel(undefined, first.hooks, first.controller, true)
  } finally {
    fetchImpl = undefined
  }
  const poll = timers.filter((entry) => entry.delay === 2500 && entry.cleared !== true)
  assert.ok(poll.length > 0, 'no re-read was scheduled while a scan was in flight')
})

check('the search finds a rule by the key it is stored under', () => {
  // An MCP row SHOWS the server (`github`) but is STORED as `mcp__github__`; a
  // raw prefix shows `automation_*` but is stored as `automation_`. Searching
  // only the visible text made the same rule findable under one spelling and
  // invisible under the other — the user pastes the key from the config and
  // gets an empty list.
  const catalog = {
    ...CATALOG,
    stored: {
      cherry: { tools: { deny: [], denyPrefix: ['mcp__github__', 'automation_'] }, skills: { denyNames: [], denyProviders: [], denySources: [] } },
    },
  }
  const byKey = renderPanel(catalog, undefined, undefined)
  // Drive the filter through the real input's onChange.
  const search = flatten(byKey.tree).find((n) => n.type === 'input' && n.props.placeholder !== undefined)
  search.props.onChange({ target: { value: 'mcp__github__' } })
  const filtered = renderPanel(catalog, byKey.hooks, byKey.controller)
  const names = checkRows(filtered.tree).map((row) => row.store ?? row.name)
  assert.ok(names.includes('mcp__github__'), `typing the stored key found nothing: [${names.join(',')}]`)
})

check('the panel reads the host inventory route, not a hardcoded list', () => {
  // With the route unavailable there is nothing to render and nothing to save:
  // the panel must not fall back to a baked-in inventory, and must not let a save
  // write a draft built on rules it cannot see.
  assert.deepEqual(checkRows(renderPanel(null).tree), [], 'the inventory came from somewhere other than the route')
  assert.equal(saveButton(renderPanel(null).tree).props.disabled, true, 'saving was possible with no inventory')
  assert.ok(checkRows(renderPanel(CATALOG).tree).map((row) => row.name).includes('weather'), 'the route inventory is not reaching the picker')
})

/* ── 4d. SkillsManager layering: enabled-state display ───────────────────── */

check('a kept-rule row (globally disabled) is tagged and stays untickable-to-nothing', () => {
  // The host lists a disabled skill ONLY when a rule names it. The row must
  // say why it is dormant and remain checked — unticking it is a real edit
  // (dropping the rule), so the box must not be locked.
  const catalog = {
    ...CATALOG,
    stored: {
      cherry: { tools: { deny: [], denyPrefix: [] }, skills: { denyNames: ['off-kept'], denyProviders: [], denySources: [] } },
    },
    skills: [
      { name: 'on-skill', description: '', provider: 'p', source: 'user-dsh', enabled: true },
      { name: 'off-kept', description: '', provider: 'p', source: 'agent-workbuddy', enabled: false },
    ],
  }
  const rows = checkRows(renderPanel(catalog).tree)
  const kept = rows.find((row) => (row.store ?? row.name) === 'off-kept')
  assert.ok(kept !== undefined, 'a configured rule on a disabled skill vanished from the picker')
  assert.equal(kept.checked, true, 'the kept-rule row must show as checked (the rule is in force)')
  assert.equal(kept.locked, false, 'a kept-rule row must stay editable so the user can drop the rule')
  // The fake locale binder echoes `ns.key`, so the tag reads as the key name.
  assert.match(String(kept.tag ?? ''), /skillOff/, 'the dormant row carries no explanation tag')
  const on = rows.find((row) => (row.store ?? row.name) === 'on-skill')
  assert.ok(on !== undefined && !/skillOff/.test(String(on.tag ?? '')), 'an enabled row was wrongly tagged disabled')
})

check('the skills footnote appears only when the host serves the enabled field', () => {
  const withField = { ...CATALOG, skills: [{ name: 'code', description: '', provider: 'bundled', source: 'bundled', enabled: true }] }
  const texts = collectText(renderPanel(withField).tree)
  assert.match(texts, /skillsNote/, 'the enabled-state footnote is missing on a new host')
  // The shipped CATALOG has no `enabled` field (an old host): the sentence
  // would describe a filter that is not running, so it must NOT appear.
  const oldTexts = collectText(renderPanel(CATALOG).tree)
  assert.doesNotMatch(oldTexts, /skillsNote/, 'an old host got a claim about filtering it never does')
})

/* ── 5. Declaration chain the host scan reads ───────────────────────────── */

check('package.json declares dsh.client.platform web', () => {
  assert.equal(PKG.dsh.client.platform, 'web')
})
check('exports["./client"] resolves to an existing file', () => {
  const target = typeof PKG.exports['./client'] === 'string' ? PKG.exports['./client'] : PKG.exports['./client'].default
  assert.equal(typeof target, 'string')
  assert.ok(existsSync(join(ROOT, target)), `${target} is missing`)
  assert.equal(PKG.type, 'module')
})
check('the package resolves to a manifest whose name matches the row name', () => {
  const req = createRequire(join(ROOT, 'index.js'))
  assert.equal(req.resolve(`${PKG.name}/package.json`), join(ROOT, 'package.json'))
  assert.equal(JSON.parse(readFileSync(req.resolve(`${PKG.name}/package.json`), 'utf8')).name, PKG.name)
})

/* ── report ─────────────────────────────────────────────────────────────── */

await Promise.all(pending)
let failed = 0
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}`)
  if (!entry.ok) {
    failed++
    console.log(`     ${String(entry.error?.stack ?? entry.error?.message ?? entry.error).split('\n').slice(0, 4).join('\n     ')}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) process.exitCode = 1
