/**
 * Round-trip closure proof.
 *
 * The property the whole picker rests on: what the boxes SHOW as checked, saved
 * through the panel's own write path, must reproduce EXACTLY those rules when the
 * host re-reads the config. Slip one way and the panel promises a hide it never
 * applies; slip the other and it silently releases a hide the user never unchecked.
 *
 * It loads the real client half (page-shaped vm + stateful fake React), feeds it a
 * catalog whose `stored` is produced by the SAME `toRulesConfig`/`buildRules` the
 * host runs, drives one toggle and one save, then re-resolves what was written and
 * compares. Nothing here re-implements the rules — a drift between the two halves
 * is exactly what this catches.
 *
 * Run: node scripts/roundtrip-proof.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { toRulesConfig } from '../lib/index.js'
import { DEFAULT_PRESET, buildRules, rulesFor } from '../lib/rules.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/* ── load the client half exactly as the page does ───────────────────────── */
const registrations = []
const win = { __ModuleLoader__: { load: ({ id, factory }) => registrations.push({ id, factory }) } }
const context = vm.createContext({ window: win, console, setTimeout, clearTimeout })
vm.runInContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), context, { filename: 'client.js' })

let hookSlots = []
let hookCursor = 0
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    // Bind the setter to THIS render's slot array, captured now. The globals are
    // reassigned by every render() and the cases below interleave at their awaits;
    // a setter reading the global at call time would write state into whichever
    // case rendered last (this leaked busy/saving state across cases in e2e).
    const slots = hookSlots
    const index = hookCursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useSyncExternalStore: (subscribe, snapshot) => snapshot(),
}
const plugin = registrations[0].factory((spec) => { if (spec === 'react') return React; throw new Error(spec) })
const registers = []
const slots = { inject: (k, cb) => { cb(); return () => {} }, register: (o, c) => { registers.push({ o, c }); return () => {} } }
let formsService
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {} },
  get: (key) => (key === 'slots' ? slots : key === 'configForms' ? formsService : undefined),
}
plugin.apply(ctx)
const mainReg = registers.find((r) => r.o.name === 'main')
const page = mainReg.c

/* ── the inventory ───────────────────────────────────────────────────────── */
const TOOL_NAMES = [
  'terminal_open', 'terminal_list', 'automation_create', 'session_trace', 'plugin_manager',
  'ralph', 'pua_reference', 'dsh_code_review', 'weather', 'video_search', 'cache_search',
  'domain_search', 'free_search_test', 'web_search', 'read', 'edit', 'mcp__github__create_pr',
]
const CATALOG = {
  ok: true,
  ownerGroups: [
    { id: 'builtin', label: 'B' },
    { id: 'official', label: 'O' },
    { id: 'thirdparty', label: 'T' },
    { id: 'local', label: 'L' },
    { id: 'mcp', label: 'M' },
    { id: 'unknown', label: 'U' },
  ],
  provenance: { scannedAt: 1, scanning: false },
  skillSources: [{ id: 'bundled', label: 'b' }],
  presets: [DEFAULT_PRESET, 'cordis'],
  mcpServers: ['github'],
  sealedBy: {},
  tools: TOOL_NAMES.map((name) => ({
    name,
    description: '',
    group: name.startsWith('mcp__') ? 'mcp' : 'builtin',
    owner: 'pkg',
  })),
  skills: [{ name: 'code', description: '', provider: 'filesystem', source: 'bundled' }],
}

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

/**
 * Everything the engine hides for one mode, across all five rule lists, in the
 * same flat vocabulary the checkboxes use — so a box and a rule are comparable.
 * The `*` merge is included because `rulesFor` applies it: those names ARE hidden
 * from this mode, locked or not.
 */
function hiddenFor(config, mode) {
  const effective = rulesFor(buildRules(toRulesConfig(config)), mode)
  if (effective === undefined) return []
  return [
    ...effective.tools.deny,
    ...effective.tools.denyPrefix,
    ...effective.skills.denyNames,
    ...effective.skills.denyProviders,
    ...effective.skills.denySources,
  ].sort()
}

function flatten(node, out = []) {
  if (node == null) return out
  if (Array.isArray(node)) { for (const e of node) flatten(e, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  flatten(node.children, out)
  return out
}
const sectionsOf = (tree) => flatten(tree).filter((n) => Array.isArray(n.props?.rows))
const rowsOf = (tree) => sectionsOf(tree).flatMap((s) => s.props.rows)
const saveElement = (tree) => flatten(tree).filter((n) => n.type === 'button')
  .find((n) => /save|保存/.test(String(n.children.flat().join(''))))

/** Render the panel for one stored config, with the host's own answer as catalog. */
function render(config, hooks, controller) {
  const effective = controller ?? {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: config, base: {}, user: {} }),
    mutate: (ops) => { effective.ops = ops; return Promise.resolve(true) },
    subscribe: () => () => {},
    ops: null,
  }
  formsService = { get: (ns) => (ns === 'cherry-toolfilter' ? effective : undefined) }
  const catalog = { ...CATALOG, stored: storedOf(buildRules(toRulesConfig(config))) }
  hookSlots = hooks ?? []
  hookCursor = 0
  const tree = page({ ...mainReg.o.inject(), catalog, useSyncExternalStore: React.useSyncExternalStore })
  return { tree, hooks: hookSlots, controller: effective, catalog, config }
}

/** The names the boxes claim this mode hides (locked rows included: they hide). */
const shownNames = (tree) => rowsOf(tree).filter((row) => row.checked === true).map((row) => row.store ?? row.name).sort()

/** Rebuild the config a recorded write would store. */
function configOf(ops) {
  const out = {}
  for (const op of ops ?? []) {
    const [key] = op.path
    if (op.op === 'set') out[key] = op.value
    else delete out[key]
  }
  return out
}

/**
 * Switch the panel to one mode by clicking its real chip. The panel opens on
 * cherry, so a proof about another mode has to navigate there the way a user does
 * — asserting against a view the user was never shown would prove nothing.
 * @param {object} view - a render() result.
 * @param {string} mode - the mode id to open.
 * @returns {object} the render after the click.
 */
function switchMode(view, mode) {
  const wanted = mode === '*' ? 'modeAll' : mode
  const chip = flatten(view.tree).filter((n) => n.type === 'button')
    .find((n) => String(n.children.flat().join('')) === wanted)
  if (chip === undefined) {
    const current = flatten(view.tree).filter((n) => n.type === 'button' && n.props?.style?.borderRadius === '999px')
      .map((n) => String(n.children.flat().join('')))
    throw new Error(`no chip for mode ${mode}; chips present: ${current.join('|')}`)
  }
  chip.props.onClick()
  return render(view.config, view.hooks, view.controller)
}

const CASES = [
  ['empty config (baseline implicit)', {}, DEFAULT_PRESET],
  ['no cherry block at all', { presets: { cordis: { tools: { deny: ['ralph'] } } } }, DEFAULT_PRESET],
  ['cherry authored empty', { presets: { cherry: { tools: { deny: [] } } } }, DEFAULT_PRESET],
  ['cherry authored list', { presets: { cherry: { tools: { deny: ['terminal_open'] } } } }, DEFAULT_PRESET],
  ['defaults true over authored cherry', { defaults: true, presets: { cherry: { tools: { deny: ['cache_search'] } } } }, DEFAULT_PRESET],
  ['defaults false', { defaults: false, presets: { cherry: { tools: { deny: [] }, skills: { denyNames: ['pdf'] } } } }, DEFAULT_PRESET],
  ['wildcard plus cherry', { presets: { '*': { tools: { deny: ['ralph'] } }, cherry: { tools: { deny: ['terminal_open'] } } } }, DEFAULT_PRESET],
  ['another mode', { presets: { cordis: { tools: { deny: ['ralph'] } } } }, 'cordis'],
  ['mcp prefix rule', { presets: { cherry: { tools: { deny: [], denyPrefix: ['mcp__github__'] } } } }, DEFAULT_PRESET],
  ['v1 legacy foreign preset', { presetId: 'standard', deny: ['ralph'] }, 'standard'],
]

let failures = 0
const queue = []
const step = (label, fn) => {
  queue.push(Promise.resolve().then(fn).then(
    () => console.log(`ok   ${label}`),
    (error) => {
      failures += 1
      console.log(`FAIL ${label}\n     ${String(error.message ?? error).split('\n').join('\n     ')}`)
    },
  ))
}

/* ── 1. The un-edited view equals what the engine hides ─────────────────── */
for (const [label, config, mode] of CASES) {
  step(`view is honest for ${mode}: ${label}`, () => {
    const view = switchMode(render(config), mode)
    assert.equal(shownNames(view.tree).join(','), hiddenFor(config, mode).join(','), `shown [${shownNames(view.tree)}] vs engine [${hiddenFor(config, mode)}]`)
  })
}

/* ── 2. One toggle, saved, must reproduce the view exactly ──────────────── */
for (const [label, config, mode] of CASES) {
  step(`save round-trip for ${mode}: ${label}`, async () => {
    const first = switchMode(render(config), mode)
    const rows = rowsOf(first.tree)
    // Prefer an unlocked checked row to untick, else an unchecked one to tick.
    const target = rows.find((row) => row.checked === true && row.locked !== true)
      ?? rows.find((row) => row.checked !== true)
    if (target === undefined) return
    const willBe = target.checked
      ? shownNames(first.tree).filter((name) => name !== (target.store ?? target.name))
      : [...shownNames(first.tree), target.store ?? target.name].sort()

    const section = sectionsOf(first.tree).find((s) => s.props.rows.some((row) => row.name === target.name))
    section.props.onToggle(target.store ?? target.name, !target.checked)
    const second = render(config, first.hooks, first.controller)
    const save = saveElement(second.tree)
    assert.ok(save !== undefined && save.props.disabled !== true, 'toggle did not unlock save')
    await save.props.onClick()

    const written = configOf(second.controller.ops)
    assert.equal(hiddenFor(written, mode).join(','), willBe.join(','), `saved hides [${hiddenFor(written, mode)}] but boxes said [${willBe}]`)

    // Idempotence: re-reading the written config must come back UN-DIRTY, else the
    // write did not capture the whole displayed state and a second save would move.
    const third = switchMode(render(written), mode)
    assert.equal(saveElement(third.tree)?.props.disabled, true, 'the saved config re-reads as an edit (not idempotent)')
    assert.equal(shownNames(third.tree).join(','), willBe.join(','), 'the re-read view lost a name the boxes showed')
  })
}

/* ── 3. A wildcard never leaks into the modes it already covers ─────────── */
step('saving one mode never materialises * into it', async () => {
  const config = { presets: { '*': { tools: { deny: ['ralph'] } }, cherry: { tools: { deny: ['terminal_open'] } } } }
  const first = render(config)
  const ralph = rowsOf(first.tree).find((row) => row.name === 'ralph')
  assert.equal(ralph.checked, true, 'the wildcard hide is invisible in the cherry view')
  assert.equal(ralph.locked, true, 'the wildcard box was offered as untickable from cherry')
  sectionsOf(first.tree).find((s) => s.props.rows.some((row) => row.name === 'weather')).props.onToggle('weather', true)
  const second = render(config, first.hooks, first.controller)
  await saveElement(second.tree).props.onClick()
  const written = configOf(second.controller.ops)
  assert.equal(written.presets['*'].tools.deny.join(','), 'ralph', 'the wildcard block was rewritten')
  assert.ok(!written.presets[DEFAULT_PRESET].tools.deny.includes('ralph'), 'wildcard names leaked into cherry')
  assert.ok(written.presets[DEFAULT_PRESET].tools.deny.includes('weather'), 'the intended tick was lost')
  // And the effective rules must still be exactly what the boxes showed.
  assert.equal(hiddenFor(written, DEFAULT_PRESET).includes('ralph'), true, 'the wildcard stopped hiding')
})

/* ── 4. A legacy v1 row survives the panel intact ───────────────────────── */
step('a legacy v1 rule stays in force across an unrelated panel save', async () => {
  // The host merges `deny` into presets on EVERY read, so a panel that renders
  // only `presets` would drop it on write — unless the merged result is carried
  // forward while the legacy fields themselves are cleared.
  const config = { presetId: 'standard', deny: ['ralph'] }
  const first = switchMode(render(config), 'standard')
  assert.equal(hiddenFor(config, 'standard').join(','), 'ralph', 'the legacy rule is invisible to the panel')
  assert.equal(rowsOf(first.tree).find((row) => row.name === 'ralph')?.checked, true, 'the legacy rule is not shown as checked')
  // Tick something unrelated and save.
  sectionsOf(first.tree).find((s) => s.props.rows.some((row) => row.name === 'weather')).props.onToggle('weather', true)
  const second = render(config, first.hooks, first.controller)
  await saveElement(second.tree).props.onClick()
  const written = configOf(second.controller.ops)
  assert.equal(written.presetId, undefined, 'the legacy presetId must not survive a panel write')
  assert.equal(written.deny, undefined, 'the legacy deny list must not survive a panel write')
  const hidden = hiddenFor(written, 'standard')
  assert.equal(hidden.includes('ralph'), true, `saving lost the legacy v1 rule: [${hidden}]`)
  assert.equal(hidden.includes('weather'), true, 'the intended tick was lost')
})

await Promise.all(queue)
if (failures > 0) {
  console.log(`\n${failures} closure failures`)
  process.exitCode = 1
} else {
  console.log('\nround-trip closure holds')
}
