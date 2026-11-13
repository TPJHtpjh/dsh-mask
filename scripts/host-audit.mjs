/** Host-half audit: exception surface + seal lifecycle under adversarial conditions. */
import assert from 'node:assert/strict'
import { apply, toRulesConfig } from '../lib/index.js'
import { buildRules, rulesFor } from '../lib/rules.js'

const results = []
const check = (label, fn) => {
  try {
    const r = fn()
    if (r instanceof Promise) return r.then(() => results.push(['ok', label]), (e) => results.push(['FAIL', label, String(e.message ?? e)]))
    results.push(['ok', label])
  } catch (e) {
    results.push(['FAIL', label, String(e.message ?? e)])
  }
  return Promise.resolve()
}

/** A fake host: services that throw, agents that appear and disappear. */
function makeHost(options = {}) {
  const log = { masked: [], released: [], audit: [], warns: [], routes: [], disposers: [] }
  const listeners = new Map()
  const services = {
    tools: {
      /** Scope-local names PER agent (the real registry scopes these views). */
      agentExtras: new Map(),
      schemas(scope) {
        if (scope === undefined) return [{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }]
        return (this.agentExtras.get(String(scope.id)) ?? []).map((name) => ({ name }))
      },
      restrict: (filter) => {
        if (options.restrictThrows) throw new Error(`cannot mask ${filter.deny?.[0]}`)
        log.masked.push(...filter.deny)
        return () => log.released.push(...filter.deny)
      },
    },
    skills: {
      list: async () => [{ name: 'skill-a', description: '', provider: 'filesystem', source: 'bundled' }],
      registerProvider: (create) => {
        if (options.skillThrows) throw new Error('registerProvider failed')
        const provider = create({ invalidate: () => log.audit.push('invalidate') })
        log.audit.push(`provider:${provider.name}`)
        for (const candidate of provider.list()) log.audit.push(`shadow:${candidate.name}`)
        return () => log.audit.push('unprovider')
      },
    },
    agentPresets: { list: async () => [{ id: 'cherry' }, { id: 'other' }], },
    configForms: { get: () => undefined },
  }
  if (options.webServer !== false) {
    services.webServer = {
      register: (route) => {
        if (options.registerThrows) throw new Error('register refused')
        log.routes.push(route)
        return () => log.disposers.push('disposed')
      },
    }
  }
  /**
   * The deferred-activation seam. Cordis only runs the callback once EVERY
   * declared service exists, so a fake that always called back immediately
   * would hide the very race this plugin had to fix.
   */
  const pending = []
  const child = {
    logger: { warn: (m) => log.warns.push(String(m)), info: () => {} },
    get: (k) => services[k],
    effect: (fn) => { const d = fn(); log.disposers.push(d); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
  }
  const ctx = {
    logger: { warn: (m) => log.warns.push(String(m)), info: () => {} },
    get: (k) => services[k],
    effect: (fn) => { const d = fn(); log.disposers.push(d); return () => { if (typeof d === 'function') d() } },
    on: (event, fn) => { listeners.set(event, fn) },
    inject: (deps, callback) => {
      if (deps.every((name) => services[name] !== undefined && services[name] !== null)) {
        return callback(child)
      }
      pending.push({ deps, callback, child })
      return {}
    },
    /** Make a service appear, like a later-activating plugin would. */
    provide(name, value) {
      services[name] = value
      for (const entry of pending.filter((p) => p.deps.includes(name))) {
        if (entry.deps.every((d) => services[d] !== undefined && services[d] !== null)) entry.callback(entry.child)
      }
    },
    emit: async (event, ...args) => {
      const fn = listeners.get(event)
      if (fn === undefined) return
      await fn(...args)
    },
  }
  return { ctx, log, listeners, services }
}

const agent = (id, preset = 'cherry') => ({
  id,
  ctx: { get: (k) => ({ tools: undefined, skills: undefined }[k]) },
  session: { header: { agentPreset: preset } },
})

// 1. A throwing `restrict()` must not break the pass or the audit.
await check('a throwing restrict() does not break the mask pass', async () => {
  const { ctx, log } = makeHost({ restrictThrows: true })
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  const a = agent('s1')
  await ctx.emit('agent/created', { agent: a })
  if (!log.warns.some((w) => w.includes('could not mask'))) throw new Error('no warning was recorded for the refused name')
  return undefined
})

// 2. `agent/disposed` must not throw even if a disposer throws.
await check('agent/disposed survives a throwing disposer', async () => {
  const { ctx } = makeHost()
  const services = ctx.get('tools')
  services.restrict = () => () => { throw new Error('disposer failed') }
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  const a = agent('s2')
  await ctx.emit('agent/created', { agent: a })
  await ctx.emit('agent/disposed', { agent: a })
  return undefined
})

// 3. A config with hostile shapes must not throw out of readCatalog.
await check('readCatalog survives hostile config shapes', async () => {
  const { ctx } = makeHost()
  const shapes = [
    { presets: null },
    { presets: 'nonsense' },
    { presets: { cherry: null } },
    { presets: { cherry: { tools: 'nonsense' } } },
    { presets: { cherry: { tools: { deny: 'not-an-array' } } } },
    { presets: { cherry: { tools: { deny: [null, 42, ''] } } } },
    { deny: 'not-an-array' },
    { deny: [null, 42] },
    { presetId: 123 },
    { defaults: 'yes' },
  ]
  for (const shape of shapes) {
    const catalog = await (await import('../lib/index.js')).readCatalog(ctx, buildRules(toRulesConfig(shape)))
    if (catalog === null || typeof catalog !== 'object') throw new Error(`catalog is not an object for ${JSON.stringify(shape)}`)
    if (!Array.isArray(catalog.tools)) throw new Error(`catalog.tools is not an array for ${JSON.stringify(shape)}`)
  }
  return undefined
})

// 4. The seal map must not leak across agents.
await check('seals are per agent', async () => {
  const { ctx, log } = makeHost()
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  await ctx.emit('agent/created', { agent: agent('s3') })
  await ctx.emit('agent/created', { agent: agent('s4') })
  if (log.masked.filter((n) => n === 'alpha').length !== 2) throw new Error('the second agent was not masked')
  return undefined
})

// 5. `rulesFor` must never return rules for an unknown mode.
await check('an unknown mode has no rules', () => {
  const rules = buildRules({ presets: { '*': { tools: { deny: ['alpha'] } } } })
  if (rulesFor(rules, 'never-configured') !== undefined) throw new Error('the wildcard opted an unconfigured mode into masking')
  return undefined
})

// 6. The catalog must never throw when the skills service misbehaves.
await check('readCatalog survives a throwing skills.list', async () => {
  const { ctx } = makeHost()
  ctx.get('skills').list = async () => { throw new Error('discovery failed') }
  const catalog = await (await import('../lib/index.js')).readCatalog(ctx, buildRules({}))
  if (!Array.isArray(catalog.skills)) throw new Error('catalog.skills is not an array')
  return undefined
})

// 7. A preset switch must release the old seals.
await check('switching preset releases the previous seals', async () => {
  const { ctx, log } = makeHost()
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  const a = agent('s5', 'cherry')
  await ctx.emit('agent/created', { agent: a })
  if (log.masked.length === 0) throw new Error('nothing was masked to begin with')
  await ctx.emit('agent-preset/selected', 's5')
  // `agent/pre-step` is a middleware: the host passes a `next` that must be
  // called, and the agent must carry the NEW preset.
  const switched = { ...a, session: { header: { agentPreset: 'other' } } }
  await ctx.emit('agent/pre-step', { agent: switched }, async () => {})
  if (log.released.length === 0) throw new Error('the seal survived the preset switch')
  return undefined
})

// 8. A malformed row must not take the route (and therefore the panel) down.
await check('a null preset block does not break the catalog', async () => {
  const { ctx } = makeHost()
  const { readCatalog } = await import('../lib/index.js')
  // `cherry:` with nothing under it is legal YAML and parses to null.
  const catalog = await readCatalog(ctx, buildRules(toRulesConfig({ presets: { cherry: null } })))
  if (!Array.isArray(catalog.tools)) throw new Error('catalog.tools is not an array')
  if (catalog.stored.cherry === undefined) throw new Error('cherry has no resolved rules')
  return undefined
})

// 9. Every preset in the map must survive a hostile block.
await check('hostile preset blocks all normalize to empty rule sets', () => {
  const rules = buildRules({ presets: { cherry: null, a: { tools: null }, b: { skills: null }, c: { tools: { deny: null } } } })
  for (const [id, entry] of rules) {
    if (!Array.isArray(entry.tools.deny) || !Array.isArray(entry.skills.denyNames)) {
      throw new Error(`preset ${id} did not normalize: ${JSON.stringify(entry)}`)
    }
  }
  return undefined
})

// 10. THE MEASURED FAILURE: `webServer` appears AFTER this plugin activated.
// The old code read the service once at apply() time and gave up forever, so
// the panel fetched an unregistered path, the server answered its plain-text
// 404 `not found`, and the picker was dead until a restart of the whole app.
// The fix defers through `ctx.inject`, which cordis runs when the service
// appears. This fake only calls the inject callback when the declared services
// actually exist, so the deferral itself is under test.
await check('a webServer that appears later still gets the catalog route', async () => {
  const { ctx, log } = makeHost({ webServer: false })
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  if (log.routes.length !== 0) throw new Error('the route registered without the service')
  // Masking is independent of the route and must already work.
  await ctx.emit('agent/created', { agent: agent('s9') })
  if (log.masked.length === 0) throw new Error('masking was gated on the route')
  ctx.provide('webServer', {
    register: (route) => { log.routes.push(route); return () => {} },
  })
  if (log.routes.length !== 1) throw new Error(`expected one deferred registration, got ${log.routes.length}`)
  const route = log.routes[0]
  if (route.path !== '/api/cherry-toolfilter/catalog') throw new Error(`wrong path: ${route.path}`)
  if (typeof route.handler !== 'function') throw new Error('the route has no handler')
  return undefined
})

// 11. The immediate path still registers when the service is there from the start.
await check('a webServer present at apply() registers the route immediately', async () => {
  const { ctx, log } = makeHost()
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  if (log.routes.length !== 1) throw new Error(`expected exactly one registration, got ${log.routes.length}`)
  return undefined
})

// 12. A refusing `register()` must not take masking down with it.
await check('a throwing register() does not break apply or masking', async () => {
  const { ctx, log } = makeHost({ registerThrows: true })
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'] } } } })
  await ctx.emit('agent/created', { agent: agent('s10') })
  if (log.masked.length === 0) throw new Error('masking died with the route')
  if (!log.warns.some((w) => w.includes('could not register'))) throw new Error('the registration failure went unreported')
  return undefined
})

// 13. The catalog's live view must agree with what the mask actually sealed.
// The panel marks live state from `sealedBy`, built from the seal maps; the
// enumeration that FINDS prefix matches for scope-local tools comes from the
// tracked live agents (`liveAgents`) — the strong references whose pruning the
// disposed handler used to promise without doing. A dead agent left there
// poisons the union with names that no longer exist; a live one missing from
// it hides prefix-masked names from the panel's live view.
await check('the catalog live view tracks what is sealed', async () => {
  const { ctx, log } = makeHost()
  const { readCatalog } = await import('../lib/index.js')
  const rulesForCatalog = () => buildRules(toRulesConfig({ presets: { cherry: { tools: { deny: ['alpha'], denyPrefix: ['scope_'] } } } }))
  apply(ctx, { audit: false, presets: { cherry: { tools: { deny: ['alpha'], denyPrefix: ['scope_'] } } } })
  const a = agent('s11')
  // A scope-local registration the host plane cannot see (the MCP shape),
  // registered ONLY for this agent.
  ctx.get('tools').agentExtras.set('s11', ['scope_mcp__tool'])
  await ctx.emit('agent/created', { agent: a })
  if (!log.masked.includes('scope_mcp__tool')) throw new Error('the prefix rule did not reach the scope-local name')
  const catalog = await readCatalog(ctx, rulesForCatalog())
  const sealed = catalog.sealedBy.s11 ?? []
  if (!sealed.includes('scope_mcp__tool')) {
    throw new Error(`sealedBy lost the prefix-masked name: ${JSON.stringify(sealed)}`)
  }
  // After disposal the agent must leave the catalog's live view entirely —
  // its seals died with its fiber and its scope is gone. The stronger claim:
  // a DEAD agent must not keep contributing its scope-local names through
  // `liveAgents` (the host plane never sees `scope_mcp__tool`, so once the
  // agent is disposed it may not appear in the inventory at all — before the
  // pruning fix it stayed until LRU eviction).
  await ctx.emit('agent/disposed', { agent: a })
  const after = await readCatalog(ctx, rulesForCatalog())
  if (after.sealedBy.s11 !== undefined) throw new Error('a disposed agent still shows as sealed')
  if (after.tools.some((entry) => entry.name === 'scope_mcp__tool')) {
    throw new Error('a disposed agent still feeds its scope names into the inventory')
  }
  return undefined
})

let failed = 0
for (const [status, label, error] of results) {
  console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'} ${label}${error === undefined ? '' : `\n     ${error}`}`)
  if (status !== 'ok') failed += 1
}
console.log(`\n${results.length - failed}/${results.length} host-half audit checks passed`)
if (failed > 0) process.exitCode = 1
