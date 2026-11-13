/**
 * Offline self-test for cherry-toolfilter.
 *
 * `apply` is driven through the same `agent/created` and `agent/pre-step` handlers
 * DSH would call, against a fake registry that mimics the documented contracts:
 *
 * - `tools.restrict({deny})` throws for a name it cannot mask (unknown, scope-local,
 *   reserved) and succeeds for a global it can, all-or-nothing per call.
 * - `skills.list({scope})` returns summaries carrying `provider` / `source`;
 *   `skills.register()` files a same-scope entry that shadows an earlier one.
 *
 * The tools fake deliberately implements `restrict()` and, separately, a
 * `schemas()` that UNDER-REPORTS on purpose. Both `schemas()` and `get()` were
 * tried against a live registry and both lied about the state of a mask, so the
 * plugin may use `schemas()` only as a name hint for prefix expansion and must
 * never read a verdict from it. This suite fails if that discipline slips.
 *
 * Run: node scripts/selftest.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, denyList, isLocalPage, readCatalog, toRulesConfig } from '../lib/index.js';
import {
  DEFAULT_DENY,
  SKILL_SOURCES,
  buildRules,
  matchSkill,
  matchTool,
  mcpServer,
  rulesEmpty,
  rulesFor,
  skillMaskable,
  sourceLabel,
} from '../lib/rules.js';
import { OWNER_GROUPS, cacheKey, groupByOwner, groupOf, installedPackages, readCache, writeCache } from '../lib/provenance.js';

const failures = [];
let checks = 0;

/**
 * Assert one condition and record the outcome.
 * @param {boolean} condition - the expectation.
 * @param {string} label - what was expected.
 */
function expect(condition, label) {
  checks += 1;
  if (!condition) failures.push(label);
}

/**
 * A fake tools registry. A restriction is accepted for a name the registry knows
 * and refused for one it does not.
 * @param {string[]} names - names the registry knows.
 * @param {{ refuse?: string[], schemasVisible?: string[] }} [options]
 *   `refuse` names throw as if scope-local; `schemasVisible` overrides the
 *   deliberately unreliable enumeration.
 */
function fakeTools(names, options = {}) {
  const tools = {
    restricted: [],
    accepted: [],
    lifted: [],
    /** Simulate tools registering only after `agent/created` returned. */
    publishLater(extra) {
      names.push(...extra);
    },
    restrict(filter) {
      if (!Array.isArray(filter?.deny) || filter.deny.length === 0) throw new Error('empty filter');
      tools.restricted.push([...filter.deny]);
      const refused = filter.deny.filter((entry) => (options.refuse ?? []).includes(entry));
      if (refused.length > 0) throw new Error(`names scope-local: ${refused.join(', ')}`);
      const unknown = filter.deny.filter((entry) => !names.includes(entry));
      if (unknown.length > 0) throw new Error(`names unknown global tool(s) ${unknown.map((n) => `"${n}"`).join(', ')}`);
      tools.accepted.push(...filter.deny);
      return () => {
        for (const entry of filter.deny) tools.lifted.push(entry);
      };
    },
    /** The lying probe: when configured, it reports fewer names than exist. */
    schemas() {
      return (options.schemasVisible ?? names.slice(0, Math.max(0, names.length - 3))).map((name) => ({ name }));
    },
  };
  return tools;
}

/**
 * A fake skill registry with the layering the real one documents.
 *
 * The real `@deepseek-ai/dsh-skill` registry merges per layer: the nearest
 * layer's entry wins a name outright, and WITHIN one layer candidates are
 * sorted by rank ascending with the first winning (measured:
 * `compareIndexedCandidates`). SkillsManager registers its provider into the
 * SAME agent layer as our shadow, with project skills at ranks 99–249 and a
 * runtime entry (`skills.register()`) at rank 250 — which is why the shadow is
 * a rank-0 provider, not a runtime registration. This fake implements exactly
 * that merge so a regression to `register()` would show up as a lost name.
 * @param {Array<{name: string, provider?: string, source?: string, invocation?: object, rank?: number}>} globalSkills
 */
function fakeSkills(globalSkills) {
  /** Providers registered through this (agent-bound) service, insertion order. */
  const providers = [];
  const runtime = new Map();

  /** Layer merge: global list, then agent-layer runtime + providers by rank. */
  function merged() {
    const byName = new Map();
    for (const skill of globalSkills) byName.set(skill.name, { rank: 400, ...skill });
    const agentLayer = [...runtime.values()];
    for (const provider of providers) {
      for (const candidate of provider.list()) agentLayer.push(candidate);
    }
    agentLayer.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    // Faithful to the real registry: WITHIN one layer the first (lowest rank)
    // wins and later duplicates are skipped; the agent layer as a whole
    // overwrites the global layer.
    const taken = new Set();
    for (const entry of agentLayer) {
      if (taken.has(entry.name)) continue;
      taken.add(entry.name);
      byName.set(entry.name, entry);
    }
    return [...byName.values()];
  }

  return {
    providers,
    /** The shadow rows currently winning their names. */
    get shadows() {
      const out = new Map();
      for (const entry of merged()) {
        if (entry.provider === 'cherry-toolfilter') out.set(entry.name, entry);
      }
      return out;
    },
    registerProvider(create) {
      const provider = create({ invalidate() {}, signal: undefined });
      providers.push(provider);
      return () => {
        const index = providers.indexOf(provider);
        if (index >= 0) providers.splice(index, 1);
      };
    },
    register(definition) {
      runtime.set(definition.name, { ...definition, rank: 250 });
      return () => runtime.delete(definition.name);
    },
    async list() {
      return merged();
    },
  };
}

/**
 * Drive one agent through the plugin's hooks.
 *
 * Agent ids default to a fresh counter value because the plugin's seal maps
 * are module-level and keyed by agent id — a shared id across scenarios
 * would inherit the previous scenario's seals. A remount simulation passes
 * the SAME explicit id twice.
 * @param {{ preset?: string, composed?: string, tools?: object, skills?: object,
 *   config?: object, steps?: number, agentId?: string,
 *   beforePreStep?: (tools: object) => void }} scenario
 * @returns {Promise<{records: object[], warnings: string[], tools: object, skills: object, agentId: string}>}
 */
let agentCounter = 0;

async function run(scenario) {
  const warnings = [];
  const handlers = new Map();
  /** Every route the plugin registered through the webServer service. */
  const routes = [];
  const services = {
    tools: scenario.rootTools,
    skills: scenario.rootSkills,
    // The panel's inventory route lives on this service. Without it the plugin
    // defers forever and the registration path is never executed, so a green
    // suite would prove nothing about the route the panel depends on.
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => routes.splice(routes.indexOf(route), 1);
      },
    },
    agentPresets: scenario.composed === undefined
      ? {}
      : {
        composedPreset: () => scenario.composed,
        ...(scenario.serviceFor === false ? {} : { serviceFor: (_agent, key) => (key === 'skills' ? scenario.skills : undefined) }),
      },
  };
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    on(event, callback) {
      handlers.set(event, callback);
    },
    get(key) {
      return services[key];
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined && services[name] !== null)) callback(ctx);
      return {};
    },
  };
  const agentCtx = {
    get: (key) => (key === 'tools' ? scenario.tools : key === 'skills' ? scenario.skills : undefined),
  };
  const agentId = scenario.agentId ?? `session-test-${(agentCounter += 1)}`;
  const agent = {
    id: agentId,
    ctx: agentCtx,
    session: { header: { agentPreset: scenario.preset, cwd: '/tmp/project' } },
  };

  apply(ctx, scenario.config ?? { audit: false });
  expect(handlers.has('agent/created'), 'the created hook was registered');
  expect(handlers.has('agent/pre-step'), 'the pre-step hook was registered');
  expect(handlers.has('tools/change') && handlers.has('skills/change'), 'registry changes are watched');
  expect(handlers.has('agent/disposed'), 'agent disposal is watched');
  // The route the masking panel depends on must be registered on every apply()
  // where the webServer service exists — asserted per scenario so the
  // registration path is actually executed, not skipped by an early return.
  expect(routes.length === 1, `expected exactly one catalog route, got ${routes.length}`);
  expect(routes[0]?.path === '/api/cherry-toolfilter/catalog', `the route registered at the wrong path: ${routes[0]?.path}`);
  expect(typeof routes[0]?.handler === 'function', 'the catalog route has no handler');

  await handlers.get('agent/created')({ agent });

  if (scenario.beforePreStep !== undefined) scenario.beforePreStep(scenario.tools);

  let entered = 0;
  const steps = scenario.steps ?? 1;
  for (let index = 0; index < steps; index += 1) {
    if (scenario.beforeStep !== undefined) scenario.beforeStep({ tools: scenario.tools, skills: scenario.skills, emit: (event) => handlers.get(event)?.() });
    const result = await handlers.get('agent/pre-step')(
      { agent, signal: undefined },
      () => { entered += 1; return { kind: 'enter', messages: [] }; },
    );
    expect(result?.kind === 'enter', 'pre-step returns the next decision, not a promise of it');
  }
  expect(entered === steps, 'pre-step always calls next() so the turn is not lost');

  const records = scenario.config?.audit ? readRecords(scenario.config.audit) : [];
  return { records, warnings, tools: scenario.tools, skills: scenario.skills, handlers, agent, routes };
}

/** The first record for one stage, or undefined. */
const stage = (records, name) => records.find((entry) => entry.stage === name);

/**
 * Read the audit lines, treating an absent file as "nothing was recorded" — a
 * preset the plugin ignores must not even create the file.
 * @param {string} file - absolute audit path.
 * @returns {object[]} parsed records, possibly empty.
 */
function readRecords(file) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'cherry-toolfilter-'));

// ---------------------------------------------------------------- rule engine

{
  const rules = buildRules({});
  expect(rulesFor(rules, 'cherry') !== undefined, 'the built-in map covers cherry');
  expect(rulesFor(rules, 'standard') === undefined, 'an unconfigured preset has no rules');
  expect(rulesFor(rules, 'cherry').tools.deny.length === denyList().length, 'the cherry baseline equals denyList()');
}

{
  const rules = buildRules({ presets: { cherry: { skills: { denyNames: ['pdf'] } } } });
  const cherry = rulesFor(rules, 'cherry');
  expect(cherry.skills.denyNames.includes('pdf'), 'a configured skill rule survives');
  expect(cherry.tools.deny.includes('weather'), 'the tool baseline folds in under an explicit preset');
}

{
  const rules = buildRules({ presets: { cherry: { tools: { deny: ['terminal_open'] } } } });
  const cherry = rulesFor(rules, 'cherry');
  expect(cherry.tools.deny.length === 1 && cherry.tools.deny[0] === 'terminal_open', 'an explicit cherry deny replaces the baseline');
  expect(buildRules({ presets: { cherry: { tools: { deny: ['x'] } } }, defaults: true }).get('cherry').tools.deny.includes('weather'), 'defaults true folds the baseline in regardless');
  expect(buildRules({ presets: { cherry: { skills: { denyNames: ['x'] } } }, defaults: false }).get('cherry').tools.deny.length === 0, 'defaults false drops the baseline');
}

{
  const rules = buildRules({ presets: { '*': { tools: { deny: ['ralph'] } }, custom: { skills: { denySources: ['bundled'] } } } });
  const custom = rulesFor(rules, 'custom');
  expect(custom.tools.deny.includes('ralph'), 'the wildcard merges into a named preset');
  expect(custom.skills.denySources.includes('bundled'), 'the named preset keeps its own rules');
  const cherry = rulesFor(rules, 'cherry');
  expect(cherry !== undefined && cherry.tools.deny.includes('ralph'), 'the wildcard also reaches the built-in cherry');
  // the wildcard NEVER opts an unlisted preset in: untouched modes stay untouched
  const rules2 = buildRules({ defaults: false, presets: { '*': { tools: { deny: ['ralph'] } } } });
  expect(rulesFor(rules2, 'standard') === undefined, 'a wildcard alone does not touch an unlisted preset');
  expect(rulesFor(rules2, 'cherry') === undefined, 'defaults false drops even a wildcard-only cherry');
}

{
  expect(matchTool('mcp__github__create_issue', { deny: [], denyPrefix: ['mcp__github__'] }), 'a prefix rule matches an MCP public name');
  expect(!matchTool('mcp__other__x', { deny: [], denyPrefix: ['mcp__github__'] }), 'a prefix rule does not over-match');
  expect(matchSkill({ name: 'a', provider: 'filesystem' }, { denyNames: [], denyProviders: ['filesystem'], denySources: [] }), 'a provider rule matches a summary');
  expect(matchSkill({ name: 'a', source: 'bundled' }, { denyNames: [], denyProviders: [], denySources: ['bundled'] }), 'a source rule matches a summary');
  expect(rulesEmpty(buildRules({ presets: { x: {} } }).get('x')), 'an empty preset is empty');
}

// ------------------------------------------------- authored-emptiness (the picker's contract)

{
  // The panel writes what is checked, so an emptied cherry selection must stay
  // empty. A `tools.deny: []` is an authored statement about tools; the absence of
  // the key is what means "never addressed" and still inherits the baseline.
  const rules = buildRules({ presets: { cherry: { tools: { deny: [], denyPrefix: [] }, skills: { denyNames: [], denyProviders: [], denySources: [] } } } });
  const cherry = rulesFor(rules, 'cherry');
  expect(cherry !== undefined, 'an emptied cherry preset is still a preset');
  expect(cherry.tools.deny.length === 0, 'unchecking everything hides nothing');
  expect(rulesEmpty(cherry), 'an emptied cherry preset is empty overall');

  const skillsOnly = buildRules({ presets: { cherry: { skills: { denyNames: ['pdf'] } } } });
  expect(skillsOnly.get('cherry').tools.deny.length === denyList().length, 'a block that never mentions tools still gets the baseline');

  expect(buildRules({ presets: { cherry: { tools: { deny: [] } } }, defaults: true }).get('cherry').tools.deny.length === denyList().length, 'defaults true folds the baseline over an empty authored list');
  expect(buildRules({ presets: { cherry: { tools: { deny: ['x'] } } }, defaults: false }).get('cherry').tools.deny.join(',') === 'x', 'defaults false keeps the authored list alone');
}

// ------------------------------------------------- provenance (what the panel shows)

{
  // The panel groups tools by WHO REGISTERED THEM, derived from the packages on
  // disk. Nothing may be invented: an unattributable name stays in `unknown`
  // rather than being guessed at from its prefix.
  expect(mcpServer('mcp__github__create_pr') === 'github' && mcpServer('terminal_open') === undefined, 'the MCP server segment is the stable identity');

  const scan = { literal: { terminal_open: { owner: '@deepseek-ai/dsh-tool-terminal', group: 'builtin' }, weather: { owner: 'dsh-free-search', group: 'thirdparty' } } };
  const groups = groupByOwner(['terminal_open', 'weather', 'mcp__github__x', 'never_seen_tool'], scan.literal);
  expect(groups.builtin.map((entry) => entry.name).join(',') === 'terminal_open', 'a shipped tool is grouped under its registering package');
  expect(groups.thirdparty.map((entry) => entry.name).join(',') === 'weather', 'a third-party plugin tool is grouped separately from shipped code');
  expect(groups.mcp.length === 1 && groups.mcp[0].owner === 'mcp:github', 'MCP tools group by server, which no source scan could ever prove');
  expect(groups.unknown.map((entry) => entry.name).join(',') === 'never_seen_tool', 'an unattributable tool is admitted as unknown, never guessed');
  expect(Object.keys(groups).join(',') === Object.keys(OWNER_GROUPS).join(','), 'every bucket has a label and no bucket is missing');

  // The bucket DECISION itself, not just its plumbing: a wrong scope reading
  // mislabels a tool silently, and no other check would see it.
  expect(groupOf('@deepseek-ai/dsh-tool-fs', true) === 'builtin', 'code inside app.asar is the app itself');
  expect(groupOf('@deepseek-ai/dsh-schedule', false) === 'official', 'a profile copy of a vendor package is an official plugin');
  expect(groupOf('@local/dsh-favorites', false) === 'local', 'a link: package is this machine\'s own');
  expect(groupOf('@local/dsh-favorites', true) === 'local', 'the local scope wins even if found in the archive');
  expect(groupOf('dsh-free-search', false) === 'thirdparty', 'an unscoped profile package is third-party');
  expect(groupOf('@michengai/dsh-automation', false) === 'thirdparty', 'another vendor scope is not the app vendor');
  expect(groupOf(undefined, false) === 'thirdparty', 'an unknown owner is never filed under the app');

  // A null preset block is legal YAML (`cherry:` with nothing under it) and used
  // to crash `normalizeRules`, which crashed `readCatalog`, which 500'd the
  // route and left the panel unable to open at all.
  const nullBlocks = buildRules({ presets: { cherry: null, a: { tools: null }, b: { skills: null } } });
  for (const [id, entry] of nullBlocks) {
    expect(Array.isArray(entry.tools.deny) && Array.isArray(entry.skills.denyNames), `a null block did not normalize: ${id}`);
  }
  expect(rulesFor(nullBlocks, 'cherry') !== undefined, 'a null cherry block still resolves');

  // The cache key carries the bucket scheme, so a release that renumbers buckets
  // cannot keep serving rows tagged with a bucket that no longer exists. This
  // reproduces the real event: a cache written by an older build (whose key had
  // no scheme version) must be refused by the current one. If the version were
  // not part of the key, the two keys would be identical and this would fail.
  const profileDir = join(sandbox, 'fake-profile')
  mkdirSync(profileDir, { recursive: true })
  const currentKey = cacheKey(profileDir, 'A:/fake/app.asar')
  // Exactly the key the previous scheme produced: the package set, unversioned.
  const legacyKey = installedPackages(profileDir).join('|')
  expect(legacyKey !== currentKey, 'the scheme version is part of the cache key')
  writeCache(sandbox, legacyKey, { literal: { x: { owner: 'y', group: 'installed' } } })
  expect(readCache(sandbox, currentKey) === undefined, 'a cache written under the old scheme version is refused')
  writeCache(sandbox, currentKey, { literal: { x: { owner: 'y', group: 'builtin' } } })
  expect(readCache(sandbox, currentKey) !== undefined, 'a cache under the current key is read back')
  // And the installed set is still part of the key: a different profile rescans.
  const otherProfile = join(sandbox, 'other-profile')
  mkdirSync(join(otherProfile, 'node_modules', 'pkg-a'), { recursive: true })
  expect(cacheKey(otherProfile, 'A:/fake/app.asar') !== currentKey, 'a different profile/package set yields a different key')

  // The archive is part of the key too — this prevents the measured poisoning: a
  // CLI/test run without `process.resourcesPath` scans profile-only, and under a
  // key that ignored the archive the Electron host read that builtin-less cache as
  // its own answer (every shipped tool showing as "owner unknown", forever, since
  // the key never changed).
  expect(cacheKey(profileDir, 'B:/other/app.asar') !== currentKey, 'a different archive yields a different key')
  const noArchiveKey = cacheKey(profileDir, undefined)
  expect(noArchiveKey !== currentKey, 'a no-archive run is keyed apart from an archived one')
  expect(readCache(sandbox, noArchiveKey) === undefined, 'the archived host cache is never served to a no-archive run')
}

// --------------------------------------------------------------------- catalog route

{
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {} },
    get: (key) => ({
      tools: {
        schemas: (scope) => (scope === undefined
          ? [{ name: 'terminal_open', description: 'open a pty' }, { name: 'mcp__github__create_pr', description: 'open a PR' }]
          : ['weather']),
      },
      skills: { list: async () => [{ name: 'code', description: 'coding', provider: 'bundled', source: 'bundled' }] },
      agentPresets: { list: async () => [{ id: 'cherry' }, { id: 'ptc' }] },
    })[key],
  };
  const rules = buildRules(toRulesConfig({ presets: { cherry: { tools: { deny: ['gone_tool'] } } } }));
  const catalog = await readCatalog(fakeCtx, rules);
  const names = catalog.tools.map((entry) => entry.name);
  expect(names.includes('terminal_open') && names.includes('weather'), 'the catalog unions the host plane and a live agent view');
  expect(names.includes('gone_tool'), 'a configured name with no registration is still listed, so a rule cannot be un-masked by an enumeration gap');
  for (const name of denyList()) expect(names.includes(name), `the baseline is pickable: ${name}`);
  expect(catalog.mcpServers.join(',') === 'github', 'MCP servers are derived from the public names');
  expect(catalog.presets.join(',') === 'cherry,ptc', 'the real preset ids reach the panel');
  expect(catalog.tools.every((entry) => typeof entry.group === 'string' && catalog.ownerGroups.some((g) => g.id === entry.group)), 'every tool is in a known provenance bucket');
  expect(catalog.tools.every((entry) => typeof entry.owner === 'string'), 'every tool carries an owner field, even when empty');
  expect(catalog.provenance !== undefined && typeof catalog.provenance.scanning === 'boolean', 'the catalog reports its provenance state');
  expect(catalog.skills[0].source === 'bundled', 'skill rows keep the metadata the rules match on');
  expect(catalog.skillSources.some((entry) => entry.id === 'bundled') && catalog.skillSources.every((entry) => typeof entry.label === 'string'), 'discovery roots come from what the registry reported, with labels');
  // The panel renders `stored` and nothing else: it must be the host's RESOLVED
  // map, so baseline folding and legacy fields cannot be re-derived (and drift)
  // in the browser.
  expect(catalog.stored !== undefined && Array.isArray(catalog.stored.cherry.tools.deny), 'stored is the resolved rule map with explicit lists');
  expect(catalog.stored.cherry.tools.deny.includes('gone_tool'), 'stored carries the authored rule');
  expect(JSON.stringify(catalog).length < 400000, 'the catalog stays small enough to fetch on every panel open');
}

{
  // A legacy v1 row must reach `stored` through the SAME function masking uses.
  const legacy = { presetId: 'standard', deny: ['ralph'] };
  const catalog = await readCatalog({
    logger: { warn: () => {}, info: () => {} },
    get: () => ({ schemas: () => [], list: async () => [] }),
  }, buildRules(toRulesConfig(legacy)));
  expect(catalog.stored.standard !== undefined && catalog.stored.standard.tools.deny.includes('ralph'), 'a legacy v1 rule is visible to the panel, not just to the mask');
  expect(catalog.stored.cherry === undefined, 'a legacy rule for another preset does not fabricate a cherry block the host never applied');
}

{
  // A hostile or unrelated local page must not be able to read the inventory.
  const cases = [
    [{ headers: { 'x-cherry-toolfilter': '1' }, socket: { remoteAddress: '127.0.0.1' } }, true, 'the app itself'],
    [{ headers: { 'x-cherry-toolfilter': '1', 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '::1' } }, false, 'a cross-site local page'],
    [{ headers: { 'x-cherry-toolfilter': '1' }, socket: { remoteAddress: '10.0.0.9' } }, false, 'a machine on the LAN'],
    [{ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, false, 'a local form post without the opt-in header'],
  ];
  for (const [request, want, why] of cases) {
    expect(isLocalPage(request) === want, `route guard ${want ? 'admits' : 'refuses'}: ${why}`);
  }
}

{
  // The registered handler END TO END: what the panel actually receives when it
  // fetches. The plain-text-404 incident proved the route can be absent while
  // everything else looks healthy, so the answer itself — status, JSON shape,
  // and the guard — is pinned through the real handler, not just its parts.
  const scenario = await run({
    preset: 'cherry', composed: 'cherry',
    tools: fakeTools(['weather', 'read']), steps: 1,
    config: { audit: false, presets: { cherry: { tools: { deny: ['gone_tool'] } } } },
  });
  const route = scenario.routes[0];
  /** A minimal node:http response stand-in. */
  const respond = () => {
    const out = { status: 0, body: '' };
    return {
      out,
      writeHead: (code) => { out.status = code; },
      end: (text) => { out.body = text; },
    };
  };
  const local = { method: 'GET', headers: { 'x-cherry-toolfilter': '1' }, socket: { remoteAddress: '127.0.0.1' } };
  const good = respond();
  await route.handler(local, good);
  expect(good.out.status === 200, `the catalog handler answered ${good.out.status}`);
  const parsed = JSON.parse(good.out.body);
  expect(parsed.ok === true, 'the catalog answer is not ok');
  expect(Array.isArray(parsed.tools) && parsed.tools.length > 0, 'the catalog answer carries no tools');
  expect(parsed.stored?.cherry?.tools?.deny?.includes('gone_tool') === true, 'the answer carries no resolved rules');
  expect(typeof parsed.text === 'undefined' && good.out.body.startsWith('{'), 'the answer is not JSON');
  // A cross-site page gets the refusal, never the inventory.
  const guarded = respond();
  await route.handler({ ...local, headers: { 'x-cherry-toolfilter': '1', 'sec-fetch-site': 'cross-site' } }, guarded);
  expect(guarded.out.status === 403, `a cross-site fetch answered ${guarded.out.status}`);
  expect(guarded.out.body.includes('"tools"') === false, 'the refusal leaked the inventory');
  // The refusal is a MACHINE CODE, not prose: the host cannot know the page's
  // language, so any string it sends would leak into an English UI untranslated.
  const refusal = JSON.parse(guarded.out.body);
  expect(refusal.code === 'not-local', `the refusal carries no machine code: ${guarded.out.body}`);
  expect(/[A-Za-z]/.test(refusal.error) === true && refusal.error === 'local-page-only', 'the refusal error is prose again');
  // A POST must not be served the inventory either.
  const posted = respond();
  await route.handler({ ...local, method: 'POST' }, posted);
  expect(posted.out.status === 405, `a POST answered ${posted.out.status}`);
}

// ----------------------------------------------------------------- tool mask

// 1. A preset with no rules is left completely alone.
{
  const tools = fakeTools(denyList().slice(0, 3).concat(['read']));
  const { records } = await run({ preset: 'standard', composed: 'standard', tools, config: { audit: join(sandbox, 'a.jsonl') } });
  expect(records.length === 0, 'an unconfigured preset writes nothing at all');
  expect(tools.restricted.length === 0, 'an unconfigured preset is never restricted');
}

// 1b. An unconfigured preset is settled on sight, so later steps cost one Set lookup.
{
  const tools = fakeTools(['weather', 'read']);
  const { warnings } = await run({ preset: 'standard', composed: 'standard', tools, steps: 5, config: { audit: false } });
  expect(tools.restricted.length === 0, 'an unconfigured preset is never restricted across steps');
  expect(warnings.length === 0, 'an unconfigured preset produces no warnings');
}

// 2. A configured preset masks exactly the names the registry knows.
{
  const tools = fakeTools(['weather', 'video_search', 'read', 'write']);
  const { records } = await run({ preset: 'cherry', composed: 'cherry', tools, config: { audit: join(sandbox, 'b.jsonl') } });
  const record = stage(records, 'created');
  expect(record.event === 'masked', 'the target preset records masked');
  expect(record.tools.masked.length === 2, 'both known deny names were masked');
  expect(record.tools.masked.includes('weather') && record.tools.masked.includes('video_search'), 'the right names were masked');
  const attempted = new Set(tools.restricted.flat());
  expect(attempted.size === denyList().length, 'every deny name is attempted at least once');
  expect(record.tools.refused.length > 0, 'names the registry does not know are recorded as refused');
  expect(record.scoped === true, 'the scoped service is recorded as the one used');
}

// 3. A masked name is never re-requested on a later pass.
{
  const tools = fakeTools(['weather', 'read']);
  const { records } = await run({ preset: 'cherry', composed: 'cherry', tools, steps: 3, config: { audit: join(sandbox, 'dedupe.jsonl') } });
  const weather = tools.restricted.flat().filter((name) => name === 'weather');
  expect(weather.length === 1, 'an already-masked name is not restricted again');
  expect(records.filter((entry) => entry.stage === 'pre-step').at(-1).tools.masked.length === 0, 'a later pass claims nothing new');
}

// 4. Tools that register after `agent/created` are masked on a later step.
{
  const tools = fakeTools(['weather', 'read']);
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools,
    steps: 4,
    config: { audit: join(sandbox, 'i.jsonl') },
    beforePreStep: (registry) => registry.publishLater(['plugin_manager', 'ralph']),
  });
  const late = records.filter((entry) => entry.stage === 'pre-step');
  expect(late.length >= 2, 'later steps keep retrying after refusals');
  const last = late.at(-1);
  const everMasked = new Set(records.flatMap((entry) => entry.tools?.masked ?? []));
  expect(everMasked.has('plugin_manager') && everMasked.has('ralph'), 'late registrations are masked');
  expect(last !== undefined, 'a pre-step record exists');
}

// 5. A stubbornly refused name stops costing every step.
{
  const tools = fakeTools(['weather', 'read'], { refuse: ['weather'] });
  const { warnings, records } = await run({ preset: 'cherry', composed: 'cherry', tools, steps: 6, config: { audit: join(sandbox, 'stubborn.jsonl') } });
  const passes = records.filter((entry) => entry.stage === 'pre-step').length;
  expect(passes <= 3, `a stubborn name stops after MAX_PASSES (saw ${passes})`);
  expect(warnings.some((message) => message.includes('giving up')), 'giving up is reported once');
}

// 5b. A registry change revives a settled agent so a late registration gets masked.
{
  const tools = fakeTools(['weather', 'read']);
  let count = 0;
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools,
    steps: 5, // the first three exhaust MAX_PASSES while the late name is unknown
    config: { audit: join(sandbox, 'recheck.jsonl') },
    beforeStep: ({ emit, tools: registry }) => {
      count += 1;
      if (count === 4 && !registry.publishHappened) {
        registry.publishHappened = true;
        registry.publishLater(['plugin_manager']);
        emit('tools/change');
      }
    },
  });
  const everMasked = new Set(records.flatMap((entry) => entry.tools?.masked ?? []));
  expect(everMasked.has('plugin_manager'), 'a change-triggered re-check masks a late registration');
}

// 5c. A disposed agent never runs a new mutation again.
{
  const tools = fakeTools(['weather', 'read']);
  const scenario = {
    preset: 'cherry',
    composed: 'cherry',
    tools,
    config: { audit: join(sandbox, 'disposed.jsonl') },
  };
  const { handlers, agent } = await run(scenario);
  await handlers.get('agent/disposed')({ agent });
  handlers.get('tools/change')();
  const before = tools.restricted.length;
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.restricted.length === before, 'a disposed agent is never re-restricted');
}

// 5d. A session that switches into a configured preset mid-life is reconsidered.
{
  let composed = 'standard';
  const tools = fakeTools(['weather', 'read']);
  const handlers = new Map();
  const agentPresets = { composedPreset: () => composed };
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, callback) => handlers.set(event, callback),
    get: (key) => (key === 'agentPresets' ? agentPresets : undefined),
  };
  const agent = { id: 'switcher', ctx: { get: (key) => (key === 'tools' ? tools : undefined) }, session: { header: { agentPreset: 'standard' } } };
  apply(ctx, { audit: false });
  await handlers.get('agent/created')({ agent });
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.restricted.length === 0, 'a non-target preset masks nothing before the switch');
  composed = 'cherry';
  handlers.get('agent-preset/selected')(agent.id, 'cherry');
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.restricted.flat().includes('weather'), 'after switching to a configured preset the mask lands');
}

// 5e. A burst of change events buys ONE re-check, so self-triggered events
// cannot spend the budget and starve the real late-registration case.
{
  // terminal_open is NOT in the initial registry: every attempt refuses, the
  // agent settles after MAX_PASSES. Then a 2000-event burst fires (if it were
  // un-throttled it would exhaust MAX_RECHECKS with no un-settling left),
  // terminal_open appears, and the single re-check bought by the burst must
  // still mask it.
  const tools = fakeTools(['weather', 'read']);
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, callback) => handlers.set(event, callback),
    get: (key) => (key === 'agentPresets' ? { composedPreset: () => 'cherry' } : undefined),
  };
  const agent = { id: 'burst', ctx: { get: (key) => (key === 'tools' ? tools : undefined) }, session: { header: { agentPreset: 'cherry' } } };
  apply(ctx, { audit: false });
  await handlers.get('agent/created')({ agent });
  for (let index = 0; index < 5; index += 1) await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(!tools.accepted.includes('terminal_open'), 'terminal_open stayed unmaskable while unregistered');
  // 2000 events in one instant: with the leading-edge throttle this burst buys
  // exactly one re-check (the budget-preservation math itself needs fake time
  // and is proven on the live session; here we pin the user-visible contract).
  for (let index = 0; index < 2000; index += 1) handlers.get('tools/change')();
  tools.publishLater(['terminal_open']);
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.accepted.includes('terminal_open'), 'a late registration after a 2000-event burst is still masked');
}

// 6. A prefix rule is expanded from the enumeration even though it under-reports.
{
  const names = ['mcp__github__a', 'mcp__github__b', 'weather', 'read'];
  const tools = fakeTools(names, { schemasVisible: ['mcp__github__a'] });
  const { records } = await run({
    preset: 'narrow',
    composed: 'narrow',
    tools,
    steps: 3,
    config: { audit: join(sandbox, 'prefix.jsonl'), presets: { narrow: { tools: { denyPrefix: ['mcp__github__'] } } } },
  });
  const everMasked = new Set(records.flatMap((entry) => entry.tools?.masked ?? []));
  expect(everMasked.has('mcp__github__a'), 'the visible prefix member is masked');
  expect(!everMasked.has('weather'), 'a prefix rule does not mask an unrelated tool');
}

// ------------------------------------------------------------------ skills

// 7. A provider rule shadows every skill of that provider and nothing else.
{
  const skills = fakeSkills([
    { name: 'alpha', provider: 'filesystem', source: 'user-dsh' },
    { name: 'beta', provider: 'skills-manager', source: 'external' },
  ]);
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'skills.jsonl'), presets: { cherry: { skills: { denyProviders: ['skills-manager'] } } } },
  });
  const record = records.find((entry) => entry.skills !== undefined);
  expect(record !== undefined, 'the skills pass is recorded');
  expect(record.skills.shadowed.includes('beta'), 'the matching provider skill was shadowed');
  expect(!record.skills.shadowed.includes('alpha'), 'a non-matching skill was left alone');
  expect(skills.shadows.get('beta').invocation.modelInvocable === false, 'the shadow is not model-invocable');
  expect(skills.shadows.get('beta').invocation.userInvocable === false, 'the shadow is not user-invocable');
}

// 8. An explicit name is shadowed even when discovery does not report it.
{
  const skills = fakeSkills([{ name: 'known', provider: 'filesystem', source: 'user-dsh' }]);
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'skillname.jsonl'), presets: { cherry: { skills: { denyNames: ['known', 'not-yet-registered'] } } } },
  });
  const record = records.find((entry) => entry.skills !== undefined);
  expect(record.skills.shadowed.includes('known'), 'a discovered name is shadowed');
  expect(record.skills.shadowed.includes('not-yet-registered'), 'an explicit name is shadowed without discovery');
}

// 9. A source rule matches the registry's root label.
{
  const skills = fakeSkills([
    { name: 'bundled-one', provider: 'filesystem', source: 'bundled' },
    { name: 'user-one', provider: 'filesystem', source: 'user-dsh' },
  ]);
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'skillsource.jsonl'), presets: { cherry: { skills: { denySources: ['bundled'] } } } },
  });
  const record = records.find((entry) => entry.skills !== undefined);
  expect(record.skills.shadowed.includes('bundled-one'), 'the bundled-root skill was shadowed');
  expect(!record.skills.shadowed.includes('user-one'), 'a user-root skill was kept');
}

// 9b. SkillsManager compatibility: a skill it has DISABLED (the registry
// reports it non-invocable) is not shadowed again — the global switch already
// hides it, and masking it here would be noise, not control.
{
  const skills = fakeSkills([
    { name: 'on-skill', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'off-skill', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: false, userInvocable: false } },
  ]);
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'smgate.jsonl'), presets: { cherry: { skills: { denyNames: ['on-skill', 'off-skill'] } } } },
  });
  const record = records.find((entry) => entry.skills !== undefined);
  expect(record.skills.shadowed.includes('on-skill'), 'an enabled skill is shadowed per the rule');
  expect(!record.skills.shadowed.includes('off-skill'), 'a globally-disabled skill is left to SkillsManager');
  expect(skills.shadows.has('on-skill') && !skills.shadows.has('off-skill'), 'only the enabled skill holds a shadow row');
}

// 9c. The rank conflict the old seam lost: a project skill SkillsManager
// reports at rank <250 in the SAME agent layer. A runtime registration
// (skills.register(), rank 250) loses the name; the shadow provider (rank 0)
// wins it. This pins the provider seam against the measured merge.
{
  const skills = fakeSkills([]);
  // SkillsManager's per-agent provider: a project skill at rank 199, enabled.
  skills.providers.push({
    name: 'dsh-skills-manager-external',
    list: () => [{ name: 'proj-skill', description: 'project skill', provider: 'dsh-skills-manager-external', source: 'project-workbuddy', invocation: { modelInvocable: true, userInvocable: true }, rank: 199 }],
    get: () => undefined,
  });
  const { records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'smrank.jsonl'), presets: { cherry: { skills: { denyNames: ['proj-skill'] } } } },
  });
  const record = records.find((entry) => entry.skills !== undefined);
  expect(record.skills.shadowed.includes('proj-skill'), 'a low-rank project skill is matched by the rule');
  expect(skills.shadows.get('proj-skill')?.provider === 'cherry-toolfilter', 'the rank-0 shadow provider WINS the name against a rank-199 same-layer entry');
  expect(skills.shadows.get('proj-skill')?.invocation.modelInvocable === false, 'the winning row is non-invocable, so the mask is real');
}

// 9d. skillMaskable is a NOT-false gate: no invocation object at all (a
// bundled skill on a machine without SkillsManager) stays maskable.
{
  expect(skillMaskable({ name: 'x' }) === true, 'a summary with no invocation defaults to enabled');
  expect(skillMaskable({ name: 'x', invocation: { modelInvocable: false, userInvocable: true } }) === false, 'model-off counts as disabled');
  expect(skillMaskable({ name: 'x', invocation: { modelInvocable: true, userInvocable: false } }) === false, 'user-off counts as disabled');
}

// 9e. The catalog serves the enabled-state field: globally-disabled skills are
// not offered UNLESS a rule already names them (kept-rule rows), and a name
// our own shadow owns is reconstructed from the seal snapshot instead of
// vanishing from the picker.
{
  const skills = fakeSkills([
    { name: 'masked-skill', provider: 'filesystem', source: 'user-dsh' },
    { name: 'off-configured', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: false, userInvocable: false } },
    { name: 'off-unconfigured', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: false, userInvocable: false } },
  ]);
  await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: false, presets: { cherry: { skills: { denyNames: ['masked-skill', 'off-configured'] } } } },
  });
  const catalog = await readCatalog({
    logger: { warn: () => {}, info: () => {} },
    get: (key) => (key === 'skills' ? skills : key === 'tools' ? { schemas: () => [] } : undefined),
  }, buildRules({ presets: { cherry: { skills: { denyNames: ['masked-skill', 'off-configured'] } } } }));
  const rows = new Map(catalog.skills.map((entry) => [entry.name, entry]));
  expect(rows.has('masked-skill'), 'a masked skill still appears in the picker (its rule is live)');
  expect(rows.get('masked-skill')?.enabled === true, 'a masked skill reads as enabled: the shadow hides it, SkillsManager did not');
  expect(rows.get('masked-skill')?.source === 'user-dsh', 'the shadow row is reconstructed with the ORIGINAL source, not cherry-toolfilter');
  expect(rows.has('off-configured') && rows.get('off-configured')?.enabled === false, 'a configured rule on a disabled skill stays listed as a kept-rule row');
  expect(!rows.has('off-unconfigured'), 'a globally-disabled skill nobody configured is not offered for masking');
}

// 9f. The dormant-rule promise, end to end: SkillsManager enables a skill a
// rule already names → the registry fires skills/change → the re-check
// un-settles the agent → the next pass places the shadow. Also proves the
// provider is registered ONCE per agent (not per name, not per pass), and
// that a later pass never "eats its own shadow": the shadow row is
// non-invocable, so without the sealed-set short-circuit a naive diff would
// un-shadow, re-see, re-shadow every step.
{
  const inventory = [
    { name: 'sleeping', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: false, userInvocable: false } },
  ];
  const skills = fakeSkills(inventory);
  const agentId = 'dormant-agent';
  const config = { audit: false, presets: { cherry: { skills: { denyNames: ['sleeping'] } } } };
  const first = await run({
    agentId, preset: 'cherry', composed: 'cherry',
    tools: fakeTools(['weather']), skills, config, steps: 2,
  });
  expect(skills.shadows.size === 0, 'a globally-disabled skill is not shadowed on the first pass');
  expect(skills.providers.length === 0, 'no shadow provider is registered when nothing is masked');

  // SkillsManager flips it on — same object, new flags (what the real provider
  // reports after its state file changes). The pass above already settled the
  // agent (clean pass), so this is the transition contract: the registry fires
  // skills/change, buyRecheck un-settles, and the NEXT pass sees the enabled row.
  inventory[0].invocation = { modelInvocable: true, userInvocable: true };
  first.handlers.get('skills/change')();
  await first.handlers.get('agent/pre-step')({ agent: first.agent }, () => ({ kind: 'enter', messages: [] }));
  expect(skills.shadows.has('sleeping'), 'enabling the skill in SkillsManager makes the dormant rule fire on the next pass');
  expect(skills.providers.length === 1, 'exactly ONE shadow provider per agent, whatever the number of names');

  // A pass over the SAME state again (a settings edit that changed nothing):
  // the shadow row is what discovery now reports — non-invocable, owned by
  // cherry. The seal must survive untouched: no un-shadow, no re-register,
  // no shadow-eating churn. volatile-update is the un-settle that does not
  // spend the re-check budget, so this pass really runs.
  first.handlers.get('loader/volatile-update')();
  const before = skills.providers.length;
  await first.handlers.get('agent/pre-step')({ agent: first.agent }, () => ({ kind: 'enter', messages: [] }));
  expect(skills.shadows.has('sleeping') && skills.providers.length === before, 'a later pass neither loses the shadow nor re-registers the provider');

  // A name that becomes maskable on a LATER pass (a second skill the rules
  // now name) must join the SAME provider — registration is per agent, never
  // per pass. A per-pass re-registration would leak providers onto the agent
  // fiber and orphan the earlier dispose/invalidate handles.
  const config2 = config;
  inventory.push({ name: 'second', provider: 'dsh-skills-manager-external', source: 'agent-workbuddy', invocation: { modelInvocable: true, userInvocable: true } });
  config2.presets.cherry.skills.denyNames = ['sleeping', 'second'];
  first.handlers.get('loader/volatile-update')();
  await first.handlers.get('agent/pre-step')({ agent: first.agent }, () => ({ kind: 'enter', messages: [] }));
  expect(skills.shadows.has('second'), 'the newly-ruled skill got its shadow row');
  expect(skills.providers.length === 1, `a later pass registered ANOTHER provider instead of reusing the one per agent (${skills.providers.length} live)`);
}

// 9g. A hand-authored denyNames entry that is NOT a valid skill name must not
// poison the registry: the real `validateCandidate` throws outside the
// provider try/catch, which would break `skills.list()` for every consumer.
// The shadow provider filters such names out of its advertised rows.
{
  const skills = fakeSkills([{ name: 'good-one', provider: 'filesystem', source: 'user-dsh' }]);
  await run({
    agentId: 'hostile-names',
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: false, presets: { cherry: { skills: { denyNames: ['good-one', 'Bad_Name', 'has space', 'UPPER'] } } } },
  });
  const advertised = skills.providers.flatMap((provider) => provider.list()).map((entry) => entry.name);
  expect(advertised.includes('good-one'), 'a valid name is advertised as a shadow row');
  expect(!advertised.includes('Bad_Name') && !advertised.includes('has space') && !advertised.includes('UPPER'), 'invalid skill names are never handed to the registry validator');
}

// 10. With no rules configured, the plugin touches no skills service at all.
{
  const skills = fakeSkills([{ name: 'alpha', provider: 'filesystem', source: 'user-dsh' }]);
  const { records } = await run({
    preset: 'standard',
    composed: 'standard',
    tools: fakeTools(['weather']),
    skills,
    config: { audit: join(sandbox, 'untouched.jsonl') },
  });
  expect(skills.shadows.size === 0, 'an unconfigured preset registers no shadow');
  expect(records.length === 0, 'an unconfigured preset writes no audit line');
}

// 11. A broken discovery pass cannot lose the tool mask or the turn.
{
  const skills = { registerProvider: () => () => {}, async list() { throw new Error('provider exploded'); } };
  const { warnings, records } = await run({
    preset: 'cherry',
    composed: 'cherry',
    tools: fakeTools(['weather', 'read']),
    skills,
    steps: 1,
    config: { audit: join(sandbox, 'skillsfail.jsonl'), presets: { cherry: { skills: { denyNames: ['x'] } } } },
  });
  expect(records.some((entry) => (entry.tools?.masked ?? []).includes('weather')), 'the tool mask still landed when skills discovery threw');
  expect(warnings.some((message) => message.includes('skill discovery pass failed')), 'the failure is reported');
}

// 12. The legacy v1 config shape still works.
{
  const tools = fakeTools(['terminal_open', 'weather', 'read']);
  const { records } = await run({
    preset: 'other',
    composed: 'other',
    tools,
    config: { audit: join(sandbox, 'v1.jsonl'), presetId: 'other', deny: ['terminal_open'] },
  });
  const record = stage(records, 'created');
  expect(record.tools.masked.includes('terminal_open'), 'the v1 presetId/deny pair still masks');
  expect(!record.tools.masked.includes('weather'), 'the v1 deny list does not inherit the cherry baseline');
}

// 12b. The shadow provider is disposed when a session leaves the rules
// entirely — the "mask skills, then remove ALL rules, then switch preset"
// path. liftStale drops names without touching the registration, so the
// ONLY thing that can take the provider out of the agent's layer is
// releaseAgent; if the empty-set branch of maskFor skipped it, every such
// session would keep a live cherry provider until its fiber died.
{
  const skills = fakeSkills([{ name: 'alpha', provider: 'filesystem', source: 'user-dsh' }]);
  const agentId = 'provider-release';
  await run({
    agentId, preset: 'cherry', composed: 'cherry',
    tools: fakeTools(['weather']), skills,
    config: { audit: false, presets: { cherry: { skills: { denyNames: ['alpha'] } } } },
  });
  expect(skills.providers.length === 1, 'the shadow provider registered while the rule was in force');
  // Switch out of the configured preset with the rules gone for this agent.
  await run({
    agentId, preset: 'cherry', composed: 'standard',
    tools: fakeTools(['weather']), skills,
    config: { audit: false, presets: { cherry: { skills: { denyNames: [] } } } },
  });
  expect(skills.providers.length === 0, `leaving the rules disposed the shadow provider (${skills.providers.length} live)`);
  expect(skills.shadows.size === 0, 'no shadow row survives the release');
}

// 13. Removing a rule lifts the seal on the SAME live agent, immediately.
// Two apply() instances over one module state simulate the settings-edit
// remount: the seal maps survive, the rules shrink, the next pass lifts.
{
  const tools = fakeTools(['weather', 'video_search', 'read']);
  const skills = fakeSkills([
    { name: 'alpha', provider: 'filesystem', source: 'user-dsh' },
    { name: 'beta', provider: 'skills-manager', source: 'external' },
  ]);
  const agentId = 'unseal-agent';
  await run({
    agentId,
    preset: 'narrow',
    composed: 'narrow',
    tools,
    skills,
    config: {
      audit: false,
      presets: { narrow: { tools: { deny: ['weather', 'video_search'] }, skills: { denyProviders: ['skills-manager'] } } },
    },
  });
  expect(tools.accepted.includes('weather'), 'both tools were sealed on the first pass');
  expect(skills.shadows.has('beta'), 'the provider match was shadowed on the first pass');
  const second = await run({
    agentId,
    preset: 'narrow',
    composed: 'narrow',
    tools,
    skills,
    config: { audit: join(sandbox, 'unseal.jsonl'), presets: { narrow: { tools: { deny: ['video_search'] } } } },
  });
  expect(tools.lifted.includes('weather'), 'the removed tool rule lifted on the live agent');
  expect(!tools.lifted.includes('video_search'), 'a still-matched tool rule stays sealed');
  expect(!skills.shadows.has('beta'), 'the removed provider rule lifted the shadow');
  const record = second.records.find((entry) => entry.stage === 'created');
  expect(record.lifted.toolsLifted.includes('weather'), 'the lift is audited');
  expect(record.lifted.skillsLifted.includes('beta'), 'the skill lift is audited');
}

// 13b. A session that switches OUT of a configured preset releases every seal.
{
  const tools = fakeTools(['weather', 'read']);
  const agentId = 'switch-out';
  await run({ agentId, preset: 'cherry', composed: 'cherry', tools, config: { audit: false } });
  expect(tools.accepted.includes('weather'), 'the tool was sealed while the preset matched');
  await run({ agentId, preset: 'cherry', composed: 'standard', tools, config: { audit: false } });
  expect(tools.lifted.includes('weather'), 'switching to an unconfigured preset lifted the seal');
}

// 15. A disposed agent is forgotten without calling anything.
{
  const tools = fakeTools(['weather', 'read']);
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, callback) => handlers.set(event, callback),
    get: (key) => (key === 'agentPresets' ? { composedPreset: () => 'cherry' } : undefined),
  };
  const agent = { id: 'gone', ctx: { get: (key) => (key === 'tools' ? tools : undefined) }, session: { header: { agentPreset: 'cherry' } } };
  apply(ctx, { audit: false });
  await handlers.get('agent/created')({ agent });
  expect(tools.accepted.includes('weather'), 'sealed before disposal');
  await handlers.get('agent/disposed')({ agent });
  expect(tools.lifted.length === 0, 'disposal does not call disposers (the agent fiber unwinds them)');
  // A re-created agent with the same id (a resumed session) is a fresh fiber:
  // the old seals died with it, so masking must start again.
  await handlers.get('agent/created')({ agent });
  expect(tools.accepted.filter((name) => name === 'weather').length === 2, 'a resumed agent is sealed again');
}

// 16. A settings edit through volatile cells re-applies rules on the SAME live
// agent without a remount: both directions (tighten a previously untouched
// agent, loosen a sealed one) settle on the next pass, and audit:false stops
// writes live. A volatile cell is the frozen `{ get }` the loader swaps in
// place; the plugin must read through it at use time, never at mount time.
function cell(initial) {
  let current = initial;
  return Object.freeze({
    get: () => current,
    set: (value) => { current = value; },
  });
}

{
  const tools = fakeTools(['weather', 'video_search', 'read']);
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, callback) => handlers.set(event, callback),
    get: (key) => (key === 'agentPresets' ? { composedPreset: () => 'cherry' } : key === 'tools' ? tools : undefined),
  };
  const agent = { id: 'volatile-agent', ctx: { get: (key) => (key === 'tools' ? tools : undefined) }, session: { header: { agentPreset: 'cherry' } } };

  // Start narrowed to a single explicit deny (which replaces the baseline),
  // delivered through volatile cells exactly as a live settings edit would.
  const presets = cell({ cherry: { tools: { deny: ['video_search'] } } });
  const audit = cell(join(sandbox, 'volatile.jsonl'));
  apply(ctx, { defaults: cell(false), presets, audit });

  await handlers.get('agent/created')({ agent });
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.accepted.includes('video_search'), 'the initial volatile rules masked their name');
  expect(!tools.accepted.includes('weather'), 'the baseline stayed out while defaults were false');

  // Tighten: the user adds weather. The agent already settled clean, so only
  // the volatile-update re-evaluation can reach it.
  presets.set({ cherry: { tools: { deny: ['video_search', 'weather'] } } });
  handlers.get('loader/volatile-update')();
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.accepted.includes('weather'), 'a newly added rule masked the live agent after the hot update');

  // Loosen: the user drops video_search again.
  presets.set({ cherry: { tools: { deny: ['weather'] } } });
  handlers.get('loader/volatile-update')();
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.lifted.includes('video_search'), 'a removed rule lifted on the live agent after the hot update');
  expect(tools.accepted.filter((name) => name === 'weather').length === 1, 'a still-matched rule was not re-sealed');

  // Audit path is live too: flipping the cell to false stops new lines.
  const before = readRecords(join(sandbox, 'volatile.jsonl')).length;
  expect(before > 0, 'the hot-update passes were audited');
  audit.set(false);
  presets.set({ cherry: { tools: { deny: ['weather', 'read'] } } });
  handlers.get('loader/volatile-update')();
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(readRecords(join(sandbox, 'volatile.jsonl')).length === before, 'audit:false stops writes without a restart');
}

// 17. The browser half's delivery contract.
// The Host API is not a UI: `settings.describe()` publishing a namespace does
// not put a form anywhere. The shipped Web UI renders only slot occupants
// (`plugins.row.config`, keyed `<package>#<row id>`), so the plugin must ship a
// client half or it has no configuration surface at all. These checks pin the
// three declarations that delivery depends on.
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = manifest.exports?.['./client'];
  const clientPath = typeof entry === 'string' ? entry : entry?.default;
  expect(typeof clientPath === 'string', 'package.json exports["./client"] names the browser half');
  expect(typeof manifest.dsh?.client?.platform === 'string', 'dsh.client.platform is declared (the client module composer requires it)');
  const client = readFileSync(new URL(`../${clientPath.replace(/^\.\//, '')}`, import.meta.url), 'utf8');
  expect(client.includes('window.__ModuleLoader__.load'), 'the browser half registers a lazy factory with the client module loader');
  expect(client.includes(`id: '${manifest.name}'`), 'the factory id is the package name');
  expect(client.includes('sidebar.panellist'), 'the panel registers a left-column icon');
  expect(client.includes("name: 'main'"), 'the panel registers the keyed main page the icon opens');
  expect(client.includes('locale.register'), 'the panel ships its own dictionaries');
  expect(client.includes('form.mutate') || client.includes('controller.mutate'), 'the panel writes through the ConfigForm controller');
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const rowId = patch.match(/id:\s*([A-Za-z0-9._-]+)/)?.[1];
  expect(rowId !== undefined && client.includes(rowId), 'the row id the bundled patch declares is the id the card keys on');
  expect(client.includes('${BUNDLE}'), 'the bundle package name is what the panel reports');
  expect(client.includes('const PANEL_ID'), 'the icon and the main page share one panel id');
}

// 18. A resumed session (same id, new fiber) is masked again.
// The measured defect: `agent/disposed` added the id to `settled` PERMANENTLY,
// so after resume `agent/pre-step` short-circuited into `next()` forever. The
// skill shadow is only ever placed in a pre-step pass, so a resumed session
// kept every skill the rules hide, and a tool that registers after resume never
// got its late pass either. Probe output before the fix:
//   resume pre-step accepted = [] | shadowed = []
{
  const registryNames = ['weather'];
  const tools = {
    accepted: [],
    restrict(filter) {
      const unknown = filter.deny.filter((n) => !registryNames.includes(n));
      if (unknown.length > 0) throw new Error(`unknown global tool "${unknown[0]}"`);
      tools.accepted.push(...filter.deny);
      return () => {};
    },
    schemas: () => registryNames.map((name) => ({ name })),
  };
  const shadowed = [];
  const skills = {
    list: async () => [{ name: 'summarize', description: '', provider: 'filesystem', source: 'bundled' }],
    registerProvider: (create) => {
      const provider = create({
        invalidate: () => {
          shadowed.length = 0;
          for (const candidate of provider.list()) shadowed.push(candidate.name);
        },
      });
      return () => {};
    },
  };
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, cb) => handlers.set(event, cb),
    get: (key) => (key === 'agentPresets' ? { composedPreset: () => 'cherry' } : undefined),
    effect: (fn) => { fn(); return () => {}; },
  };
  const agent = {
    id: 'resumed-lock',
    ctx: { get: (key) => (key === 'tools' ? tools : key === 'skills' ? skills : undefined) },
    session: { header: { agentPreset: 'cherry', cwd: '/tmp/x' } },
  };
  // `later_` is a PREFIX rule, the shape a late MCP server actually arrives in:
  // the name does not exist yet, so only a re-check after `tools/change` can
  // expand it. An exact name in `deny` would never match a name nobody wrote.
  apply(ctx, {
    audit: false,
    presets: { cherry: { tools: { deny: ['weather', 'late_tool'], denyPrefix: ['later_'] }, skills: { denyNames: ['summarize'] } } },
  });

  await handlers.get('agent/created')({ agent });
  expect(tools.accepted.includes('weather'), 'the first pass masks the registered name');
  registryNames.push('late_tool');
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.accepted.includes('late_tool'), 'the late pass masks the name registered after created');
  expect(shadowed.includes('summarize'), 'the first pre-step placed the skill shadow');

  await handlers.get('agent/disposed')({ agent });

  // Resume: same id, brand-new fiber, seals gone with the old one.
  tools.accepted = [];
  shadowed.length = 0;
  await handlers.get('agent/created')({ agent });
  expect(tools.accepted.includes('weather'), 'resume re-masks on created');
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  // After resume everything already registered was masked at created, so the
  // pass's remaining contract is the skill shadow — the thing the defect lost.
  expect(shadowed.includes('summarize'), 'a resumed session re-places the skill shadow (the settled-verdict defect)');

  // A tool registering AFTER the resume: the registry fires `tools/change`, the
  // re-check un-settles the agent, and the prefix rule expands to the new name.
  registryNames.push('later_mcp__tool');
  handlers.get('tools/change')();
  tools.accepted = [];
  await handlers.get('agent/pre-step')({ agent }, () => ({ kind: 'enter', messages: [] }));
  expect(tools.accepted.includes('later_mcp__tool'), 'a resumed session still retries late registrations');
}

rmSync(sandbox, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`FAIL ${failures.length}/${checks} checks`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS ${checks} checks`);
