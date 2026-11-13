/**
 * Narrow the tool and skill surface of sessions composed from configured agent presets.
 *
 * A preset can only ADD rows; tools and skills other bundles register at the Host
 * plane stay visible to every Agent and, under PTC, every one of them is rendered
 * into the prompt as real context cost. Two scoped switches remove them, and a
 * preset's YAML cannot call either — this plugin is the caller, driven by rules in
 * its row configuration:
 *
 *   tools  — `ctx.tools.restrict({ deny: [name] })`, one name at a time.
 *   skills — ONE same-name shadow provider registered into the agent's own
 *            skill layer with `agent.ctx.skills.registerProvider()`, whose
 *            candidates carry `invocation: { modelInvocable: false, userInvocable: false }`.
 *            The skill registry is host+per-scope layered: the nearest layer
 *            wins a duplicate name outright, and WITHIN one layer the rank
 *            decides (measured in `@deepseek-ai/dsh-skill`: candidates are
 *            sorted by rank and the first wins). A runtime entry — what
 *            `skills.register()` produces — sits at rank 250, while
 *            SkillsManager registers its own provider into the SAME agent layer
 *            with project skills at ranks 99–249. So a `register()` shadow
 *            silently LOSES those names and masks nothing. A provider at rank 0
 *            wins every same-layer collision, which is why the shadow is a
 *            provider and not a runtime registration.
 *            The shadow retires the skill for this agent alone: the catalog
 *            drops it (the `skill` tool's consumer filters on modelInvocable)
 *            and loading it fails as not invocable. Rewriting the catalog
 *            message instead was measured against the consumer's digest fold
 *            and would thrash every step — the shadow is the supported seam.
 *
 * SkillsManager compatibility, second half: it owns the GLOBAL switch, encoded
 * as `invocation` on every candidate it reports (a skill switched off there is
 * reported non-invocable). This plugin is the per-mode switch layered on top, so
 * it only ever shadows skills that are globally enabled — `skillMaskable()` in
 * rules.js. A rule pointing at a currently-disabled skill stays configured and
 * dormant; when SkillsManager enables it the registry fires `skills/change`,
 * the re-check machinery below un-settles the agent, and the shadow is placed.
 *
 * Three facts drive the tool half (each was measured on a live registry):
 *
 * 1. `restrict()` fails on unknown names, scope-local names and reserved transport
 *    names. Because early passes run before every row has registered, an uncaught
 *    throw would fail session creation, so every application is probed per name.
 * 2. `schemas(scope)` and `get(name, scope)` both lied about mask state and are not
 *    trusted. `restrict()` is its own probe: a clean return means masked, a throw
 *    means nothing to mask here. Prefix rules are the exception — expanding a
 *    prefix needs an enumeration, so `schemas` is used as a NAME HINT ONLY (a miss
 *    is retried on the next pass; a false candidate is rejected by `restrict()`
 *    itself). No verdict is ever read from `schemas`.
 * 3. The mask is an optimization, never a gate: every step is guarded and a failure
 *    is recorded and otherwise ignored.
 *
 * Each decision is appended to `audit.jsonl` beside this package. That file is the
 * only durable evidence of what the mask actually did — `ctx.logger` output goes
 * to the host's stdout and is gone by the time anyone asks.
 */

import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  DEFAULT_DENY,
  DEFAULT_PRESET,
  buildRules,
  matchSkill,
  matchTool,
  mcpServer,
  rulesEmpty,
  rulesFor,
  skillMaskable,
  sourceLabel,
} from './rules.js';
import { OWNER_GROUPS, asarPath, cacheKey, groupByOwner, readCache, writeCache } from './provenance.js';

export const name = 'cherry-toolfilter';

/**
 * Resolve schemastery, the schema library the settings page projects `Config`
 * through, from a package installed OUTSIDE the profile tree.
 *
 * Without a resolvable schema, `Config` is undefined, the settings service
 * skips this entry entirely (measured: 35 served namespaces, ours absent), and
 * the plugin has no configuration surface — while masking itself keeps working,
 * because masking never reads the schema. `loadSchemastery` therefore tries the
 * bare import first (the normal case for a package installed inside the tree),
 * then the candidate profile directories.
 */
/**
 * Directories that may hold the profile's hoisted `node_modules`.
 *
 * Measured on the live desktop Host: `DSH_PROFILE_DIR` is absent from the
 * Electron process, while `process.cwd()` IS the profile directory and
 * `<cwd>/node_modules/@deepseek-ai/schemastery/lib/index.mjs` exists. CLI hosts
 * are the other way round, so both are tried, plus the ancestors of cwd (a
 * profile can sit one level below a shared tree).
 * @returns {string[]} candidate directories, nearest first.
 */
function schemasteryCandidates() {
  const dirs = [];
  const push = (value) => {
    if (typeof value === 'string' && value !== '') dirs.push(value);
  };
  push(process.env.DSH_PROFILE_DIR);
  push(process.cwd());
  try {
    let dir = process.cwd();
    for (let step = 0; step < 3; step += 1) {
      dir = dirname(dir);
      push(dir);
    }
  } catch {
    /* an unresolvable cwd simply yields no extra candidate */
  }
  return [...new Set(dirs)];
}

async function loadSchemastery() {
  try {
    const module = await import('@deepseek-ai/schemastery');
    if (module?.default?.object) return module.default;
  } catch {
    /* not resolvable from a link: package; try the profile layouts */
  }
  for (const dir of schemasteryCandidates()) {
    for (const relative of ['node_modules/@deepseek-ai/schemastery/lib/index.mjs', '../node_modules/@deepseek-ai/schemastery/lib/index.mjs']) {
      const full = join(dir, ...relative.split('/'));
      try {
        if (!existsSync(full)) continue;
        const module = await import(pathToFileURL(full).href);
        if (module?.default?.object) return module.default;
      } catch {
        /* keep looking */
      }
    }
  }
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') {
    try {
      const url = new URL('file:///' + `${profileDir}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`.replace(/\\/g, '/'));
      const module = await import(url.href);
      if (module?.default?.object) return module.default;
    } catch {
      /* profile path absent or unreadable */
    }
  }
  return undefined;
}

const z = await loadSchemastery();

/**
 * Mark a schema node live-editable, when the loaded schemastery supports it.
 *
 * The settings page renders a form ONLY for fields reachable through a
 * `.volatile()` marker (the host's `volatileForm()` returns nothing for an
 * entry with no volatile field, and the entry is then skipped entirely). A
 * volatile field is resolved into a frozen reference the loader swaps in place
 * on a settings edit — no plugin remount — so the plugin must read it through
 * `liveValue()`. Older schemastery builds without the method are probed for,
 * not assumed: unmarked, the fields still validate and apply at mount, they
 * just need a restart to change.
 */
const live = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema);

/**
 * Read one config value, unwrapping the loader's volatile reference.
 *
 * A volatile field arrives as a frozen `{ get }` cell; an ordinary (or a
 * schemastery-less) field arrives as the plain value. The duck-type is
 * `frozen && has a get function`: YAML-produced config objects are never
 * frozen, so a preset literally named `get` (whose value is an object, not a
 * function) cannot be mistaken for a cell.
 */
function liveValue(value) {
  return value !== null && typeof value === 'object' && Object.isFrozen(value) && typeof value.get === 'function'
    ? value.get()
    : value;
}

/**
 * One preset's rule block. Every field optional; omitted means empty.
 *
 * Presence is meaningful: a `tools.deny` array, even an empty one, is an authored
 * statement about tools and stands on its own, while a block that never mentions
 * `tools.deny` has not addressed tools and inherits the built-in baseline. That is
 * what lets the masking panel write back the full list on every save and keep
 * "uncheck everything" mean hide nothing.
 */
const ruleBlock = () => z.object({
  tools: z.object({
    deny: z.array(z.string()).description('The exact tool names to hide. An empty array hides nothing.'),
    denyPrefix: z.array(z.string()).description('Name prefixes to hide; targets MCP tools as mcp__<server>__ (e.g. mcp__github__).'),
  }).description('Tool masking rules.'),
  skills: z.object({
    denyNames: z.array(z.string()).description('Exact skill names to hide, even before they exist. A skill the Skills Manager has switched off is left alone while it stays off — the global switch already hides it — and the rule fires the moment it is enabled.'),
    denyProviders: z.array(z.string()).description('Hide every skill reported by these providers (e.g. filesystem, runtime, skills-manager).'),
    denySources: z.array(z.string()).description('Hide skills discovered from these roots. The valid ids are whatever the registry actually reports (the masking panel lists them) — do not copy a fixed table: on this machine they are agent-agents, agent-workbuddy, bundled, custom and user-dsh.'),
  }).description('Skill masking rules.'),
});

/**
 * The exported Config schema, or undefined when schemastery was unreachable.
 * Every field is marked live so the settings page renders the form (a field
 * without a volatile marker is invisible there) and edits apply to running
 * sessions without a remount. `defaults` is only an override for hand-written
 * YAML: the panel never sets it, because it always writes the full list.
 */
export const Config = z === undefined ? undefined : z.object({
  defaults: live(z.boolean()).description('Force the built-in baseline on (true) or off (false) regardless of what the lists say. Leave unset to let each preset\'s own list stand.'),
  presets: live(z.dict(ruleBlock())).description('Rules per agent preset id; "*" merges into every other configured preset.'),
  presetId: live(z.string()).description('Legacy v1: the single preset to mask.'),
  deny: live(z.array(z.string())).description('Legacy v1: the full deny list for presetId.'),
  audit: live(z.union([z.boolean(), z.string()])).description('false disables the audit log; a string sets its path.'),
}).description('Per-preset tool and skill masking rules.');

/**
 * The built-in cherry baseline, kept as a function because the audit and
 * verification scripts import it as one.
 * @returns {string[]} a copy of the default tool deny names.
 */
export function denyList() {
  return [...buildRules({}).get(DEFAULT_PRESET).tools.deny];
}

/** Audit log lives beside this package so the mode keeps its own files together. */
const AUDIT_FILE = 'audit.jsonl';

/** The panel's read-only catalog route, shared with lib/client.js. */
const API_PREFIX = '/api/cherry-toolfilter';

/** Roll the audit log over rather than letting it grow without bound. */
const AUDIT_MAX_BYTES = 512 * 1024;

/** How many late passes an Agent gets before the plugin stops retrying. */
const MAX_PASSES = 3;

/**
 * Read an optional service from one context, property access first.
 *
 * Property access is tried first and `ctx.get()` second. Both bind to the
 * CALLING context — a live probe showed `agent.ctx.skills` THROWING
 * (`cannot get property "skills" without inject` when the module declares no
 * inject) while `agent.ctx.get('skills')` returned the agent-bound service.
 * The binding is therefore not the risk; WHICH context you pass is. Reach
 * through `agent.ctx` for anything scope-writing (`restrict()`,
 * `skills.registerProvider()`), never through the plugin's root context, whose
 * services would write the global layer. `scopedService()` is the shape for
 * agent-scoped reads.
 * @param {object} ctx - the context to read the service from.
 * @param {string} key - the service name.
 * @returns {object | undefined} the context-bound service, or undefined.
 */
function service(ctx, key) {
  try {
    const direct = ctx?.[key];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* a getter that throws is not a usable service */
  }
  try {
    const get = ctx?.get;
    const value = typeof get === 'function' ? Reflect.apply(get, ctx, [key]) : undefined;
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Read a service of one Agent's own context, or nothing.
 *
 * Reads strictly through `agent.ctx` — property first, then the agent's own
 * `get()`. Never the plugin's root context: `skills.registerProvider()` files
 * into "the calling context's layer", and a service taken from the plugin
 * context would write the shadow into the GLOBAL layer, hiding the skill from
 * every mode instead of just this Agent. Property access on an agent context throws
 * `cannot get property "x" without inject` when this module declared no
 * inject, which is exactly why the `get()` fallback lives here too — a probe
 * on a live cordis Agent showed the property throwing while its own
 * `get('skills')` returned the agent-bound service. `agentPresets.serviceFor()`
 * tried between them answers with the agent's scope and exists for callers
 * without the context, but on this runtime it answers undefined for `skills`,
 * so it is kept as a middle attempt only.
 * @param {object} root - the plugin's context (for `agentPresets` only).
 * @param {object} agent - the live Agent.
 * @param {string} key - the service name.
 * @returns {object | undefined} the scope-bound service, or undefined.
 */
function scopedService(root, agent, key) {
  const scoped = service(agent?.ctx, key);
  if (scoped !== undefined) return scoped;
  try {
    const registry = service(root, 'agentPresets');
    const value = registry?.serviceFor?.(agent, key);
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * The preset id an Agent is composed from.
 *
 * `agentPresets.composedPreset()` is the authoritative source; a composed
 * generation that throws is not a preset, so fall back to the session header.
 * Both answers are returned so the audit log can show which one spoke.
 * @param {import('@deepseek-ai/cordis').Context} root - the plugin's context.
 * @param {object} agent - the live Agent.
 * @returns {{ composed?: string, declared?: string, id?: string }}
 */
function presetOf(root, agent) {
  const result = {};
  const registry = service(root, 'agentPresets');
  if (registry !== undefined) {
    try {
      const id = registry.composedPreset?.(agent.ctx);
      if (typeof id === 'string' && id !== '') result.composed = id;
    } catch {
      /* a collected generation is not a preset for this Agent */
    }
  }
  const declared = agent.session?.header?.agentPreset;
  if (typeof declared === 'string' && declared !== '') result.declared = declared;
  result.id = result.composed ?? result.declared;
  return result;
}

/**
 * Live seals, keyed by agent id. Module-level on purpose.
 *
 * `restrict()` and `skills.registerProvider()` bind their effect to the CALLING
 * context — we call them through `agent.ctx`, so the restriction lives on the
 * AGENT's fiber and survives a remount of this plugin. The returned disposer
 * is the only thing that can lift it, so the disposers must survive the
 * remount too: a module-scope Map does (ESM cache), an `apply()` closure does
 * not. This is what makes un-doing a rule instant for live sessions instead
 * of new-session-only, the same contract dsh-prime-memory's tool sealing
 * offers.
 *
 * `sealedTools`: agent id -> Map(tool name -> disposer).
 * `sealedSkills`: agent id -> Map(skill name -> { provider, source }).
 * The stored skill metadata is what the stale-unseal check matches rules
 * against WITHOUT re-discovery: our own shadow provider wins the name, so a
 * discovery-driven diff would see the shadow's metadata, call it a mismatch,
 * un-shadow, re-see, re-shadow every step.
 * `shadowHandles`: agent id -> { current: { dispose, invalidate } | undefined }.
 * ONE provider registration per agent, created lazily on the first shadow;
 * the masked set lives in `sealedSkills` and the provider reads it at list()
 * time, so changing a rule mutates the set and calls invalidate() instead of
 * re-registering.
 */
const sealedTools = new Map();
const sealedSkills = new Map();
const shadowHandles = new Map();

/**
 * Every Agent the catalog may look at, id -> agent, kept at module scope for the
 * same reason the seals are: the catalog route needs live agents to union their
 * scope-local tool names, and it can be opened long after `apply()` ran.
 *
 * It is a strong reference to Agent objects, so it is bounded to the most recent
 * few entries (re-touching an id moves it to the back) and pruned on
 * `agent/disposed`. The catalog treats this as a best-effort name hint anyway —
 * every configured or already-sealed name is listed regardless.
 */
const liveAgents = new Map();
const MAX_TRACKED_AGENTS = 12;

/** Remember one Agent for the catalog without growing the map without bound. */
function trackAgent(id, agent) {
  if (liveAgents.has(id)) liveAgents.delete(id);
  liveAgents.set(id, agent);
  while (liveAgents.size > MAX_TRACKED_AGENTS) {
    const oldest = liveAgents.keys().next();
    if (oldest.done === true) break;
    liveAgents.delete(oldest.value);
  }
}

/**
 * Apply the deny mask to tools, one name at a time, keeping each disposer.
 *
 * `restrict()` is itself the probe, and it is the only one worth trusting here
 * (see the header comment on why `schemas` and `get` were abandoned). A throw
 * means "nothing to mask here" — unknown, scope-local, or reserved — and a
 * clean return means "masked". Per-name application is deliberate:
 * `restrict()` is all-or-nothing over a batch, so one unmaskable name would
 * reject the whole call and leave every requested tool visible.
 * @param {object} tools - the scoped tools service.
 * @param {string[]} names - requested names (already rule-expanded).
 * @param {Map<string, () => void>} sealed - live name→disposer map; updated in place.
 * @param {(message: string) => void} warn - logger for refused names.
 * @returns {object} a record describing what happened.
 */
function applyDeny(tools, names, sealed, warn) {
  const masked = [];
  const refused = [];
  const errors = [];
  for (const toolName of names) {
    if (sealed.has(toolName)) continue;
    try {
      const disposer = tools.restrict({ deny: [toolName] });
      // A non-function return still means masked; store a no-op so the name
      // is not re-requested and the unseal path stays uniform.
      sealed.set(toolName, typeof disposer === 'function' ? disposer : () => {});
      masked.push(toolName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refused.push(toolName);
      errors.push(`${toolName}: ${message}`);
      warn(`restrict() could not mask "${toolName}": ${message}`);
    }
  }
  return {
    requested: names.length,
    masked,
    ...(refused.length === 0 ? {} : { refused, error: errors.join('; ') }),
  };
}

/**
 * Read candidate tool names for prefix expansion, best effort.
 *
 * `schemas(scope)` under-reports (it enumerated 35 for an Agent whose own view
 * held 73), so this is a hint, never a verdict: names it misses are picked up
 * by a later pass once the registry has finished populating, and names it
 * invents are rejected by `restrict()` in {@link applyDeny}.
 * @param {object | undefined} tools - the scoped tools service.
 * @param {object} scope - the agent (the scope key).
 * @returns {string[]} visible names, possibly incomplete.
 */
function visibleNames(tools, scope) {
  try {
    const schemas = tools?.schemas?.(scope);
    if (!Array.isArray(schemas)) return [];
    return schemas.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((entry) => typeof entry === 'string' && entry !== '');
  } catch {
    return [];
  }
}

/** The provider name our shadow registers under (registry enforces candidate.provider === name). */
const SHADOW_PROVIDER = 'cherry-toolfilter';

/** The host's skill-name grammar (measured: `@deepseek-ai/dsh-skill` SKILL_NAME). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Ensure this agent's shadow provider exists, reading the live sealed set.
 *
 * ONE registration per agent, not one per name: the provider's `list()` answers
 * with a rank-0 non-invocable candidate for every currently-sealed name, so
 * changing a rule is a Set mutation plus `invalidate()` — no re-registration,
 * and no "provider already registered" throw on the second name. Rank 0 is the
 * whole point: within one layer the registry sorts candidates by rank and the
 * first wins (measured in `@deepseek-ai/dsh-skill` `compareIndexedCandidates`),
 * and SkillsManager registers its provider into the SAME agent layer with
 * project skills at ranks 99–249 — a runtime entry (rank 250, what
 * `skills.register()` makes) loses those names and masks nothing.
 *
 * `list()` filters to kebab-case names, and this is NOT decoration: the
 * registry validates every candidate OUTSIDE the provider try/catch
 * (`validateCandidate` throws on a non-kebab name, which would poison
 * `skills.list()` for EVERY consumer — the skill tool's own catalog — turning
 * one hand-authored `denyNames: ['My_Skill']` into a broken skill system).
 * A sealed name that is not a valid skill name can never collide with a real
 * skill anyway, so its shadow row is simply not advertised.
 * @param {object} skills - the agent-bound skills service.
 * @param {Map<string, object>} sealed - this agent's live shadow set, read at list() time.
 * @returns {{dispose: () => void, invalidate: () => void} | undefined} the handle, or undefined on failure.
 */
function ensureShadowProvider(skills, sealed, warn) {
  let control = null;
  try {
    const dispose = skills.registerProvider((registration) => {
      control = registration;
      return {
        name: SHADOW_PROVIDER,
        list: () => [...sealed.keys()].filter((name) => SKILL_NAME_RE.test(name)).map((name) => ({
          name,
          description: 'hidden by cherry-toolfilter',
          invocation: { modelInvocable: false, userInvocable: false },
          provider: SHADOW_PROVIDER,
          source: SHADOW_PROVIDER,
          rank: 0,
          locator: { hiddenBy: SHADOW_PROVIDER },
        })),
        get: () => undefined,
      };
    });
    return {
      dispose: typeof dispose === 'function' ? dispose : () => {},
      // `invalidate()` is the registry's own cache-bust for this registration;
      // a control that never arrived (a non-conforming service) is a no-op —
      // the next step's discovery re-lists anyway.
      invalidate: () => {
        try {
          control?.invalidate?.();
        } catch {
          /* invalidation is a hint, never a gate */
        }
      },
    };
  } catch (error) {
    warn(`shadow provider could not register: ${String(error)}`);
    return undefined;
  }
}

/**
 * Shadow-list the skills this rule set hides for one agent.
 *
 * Discovery runs against the agent's own view (`scope: agent`). A skill is
 * shadowed only when (a) a rule matches it AND (b) it is globally ENABLED —
 * the `invocation` flags SkillsManager reports through the registry
 * (`skillMaskable`). That is the compatibility contract: SkillsManager owns
 * the global switch, this plugin is the per-mode switch layered on top, and
 * masking something already switched off is not masking, it is noise. A rule
 * pointing at a disabled skill stays configured and dormant; enabling it there
 * fires `skills/change`, the re-check un-settles the agent, and the shadow is
 * placed on the next pass. Explicit denyNames for names discovery does not
 * report at all still shadow preemptively (nothing has declared them disabled;
 * if one appears enabled later the rank-0 shadow retires it, which is exactly
 * what the rule asked for). The stored `provider`/`source` snapshot is what
 * the unseal diff matches rules against without re-discovery — our own shadow
 * wins the name, so re-discovery would only ever see the shadow.
 * @param {object} skills - the agent-bound skills service.
 * @param {object} agentRules - the resolved rule set.
 * @param {object} lookup - registry view options ({ cwd?, scope, signal? }).
 * @param {Map<string, {provider: string, source: string, description: string}>} sealed - live shadow set; updated in place.
 * @param {(message: string) => void} warn - logger.
 * @param {{current: {dispose: () => void, invalidate: () => void} | undefined}} handle - live provider holder; registered on the first shadow.
 * @returns {Promise<object>} a record describing what happened.
 */
async function shadowSkills(skills, agentRules, lookup, sealed, warn, handle) {
  const summaries = await skills.list(lookup);
  const meta = new Map();
  for (const skill of summaries) meta.set(skill.name, skill);
  const matches = summaries.filter((skill) => matchSkill(skill, agentRules.skills) && skillMaskable(skill));
  const names = new Set(matches.map((skill) => skill.name));
  for (const explicit of agentRules.skills.denyNames) {
    const seen = meta.get(explicit);
    // Undiscovered: shadow it (dormant until it appears). Discovered but
    // globally disabled: leave it to SkillsManager — the rule stays in the
    // config and re-checks on the next skills/change.
    if (seen === undefined || skillMaskable(seen)) names.add(explicit);
  }
  const toPlace = [...names].filter((skillName) => !sealed.has(skillName));
  if (toPlace.length > 0 && handle.current === undefined) {
    handle.current = ensureShadowProvider(skills, sealed, warn);
  }
  const shadowed = [];
  if (handle.current !== undefined) {
    for (const skillName of toPlace) {
      const original = meta.get(skillName);
      sealed.set(skillName, {
        provider: original?.provider ?? '',
        source: original?.source ?? '',
        description: typeof original?.description === 'string' ? original.description : '',
      });
      shadowed.push(skillName);
    }
    if (shadowed.length > 0) handle.current.invalidate();
  }
  return {
    discovered: summaries.length,
    matched: matches.length,
    shadowed,
    ...(handle.current === undefined && toPlace.length > 0 ? { failed: toPlace } : {}),
  };
}

/**
 * Lift seals whose rule is gone, so removing a config entry restores live
 * sessions immediately instead of only new ones.
 *
 * A seal is stale when the CURRENT rules no longer match it. Tools: the name
 * matches no longer (exact list shrank, or a prefix member fell out of every
 * prefix). Skills: neither the stored provider/source snapshot nor any current
 * denyNames value matches. Explicit denyNames shadows for never-discovered
 * names keep empty metadata and are released exactly when the name leaves the
 * list. A tool disposer that throws (e.g. its agent fiber already disposed) is
 * dropped silently — the seal is gone either way. Skill names are removed from
 * the live set; the caller invalidates the shared provider so discovery drops
 * their rows.
 * @param {object} agentRules - the resolved rule set currently in force.
 * @param {Map<string, () => void>} tools - this agent's live tool seals.
 * @param {Map<string, {provider: string, source: string, description: string}>} skills - this agent's live skill shadows.
 * @param {(message: string) => void} warn - logger.
 * @returns {object} a record of what was lifted.
 */
function liftStale(agentRules, tools, skills, warn) {
  const toolsLifted = [];
  const skillsLifted = [];
  for (const [toolName, disposer] of tools) {
    if (matchTool(toolName, agentRules.tools)) continue;
    try {
      disposer();
    } catch (error) {
      warn(`lifting restriction "${toolName}" failed: ${String(error)}`);
    }
    tools.delete(toolName);
    toolsLifted.push(toolName);
  }
  for (const [skillName, entry] of skills) {
    const stillMatched = matchSkill({ name: skillName, provider: entry.provider, source: entry.source }, agentRules.skills);
    if (stillMatched) continue;
    skills.delete(skillName);
    skillsLifted.push(skillName);
  }
  return { toolsLifted, skillsLifted };
}

/** Directory holding this package, resolved from the module's own URL. */
function packageDir() {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    return undefined;
  }
}

/**
 * Append one JSON line to the audit log, rolling it over when it gets large.
 * @param {string} file - absolute path.
 * @param {object} entry - the decision to record.
 */
function record(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > AUDIT_MAX_BYTES) writeFileSync(file, '');
    } catch {
      /* absent or unreadable is the normal first-write case */
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* the audit log must never break session creation */
  }
}

/**
 * Read one string header, tolerating the array form node gives for repeats.
 * @param {object} request - node:http request.
 * @param {string} name - lower-cased header name.
 * @returns {string | undefined}
 */
function headerOf(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a request is this machine's own app talking to us.
 *
 * The catalog route reads the whole host tool and skill inventory, so it is not
 * something any page on this machine may fetch: any local tab could map the
 * profile. Same criteria dsh-favorites applies to its own routes — loopback
 * socket, an explicit opt-in header the browser sends because it is a custom
 * request header (so a cross-site form post cannot carry it), and same-origin
 * when the browser reports it.
 * @param {object} request - node:http request.
 * @returns {boolean}
 */
export function isLocalPage(request) {
  if (headerOf(request, 'x-cherry-toolfilter') !== '1') return false;
  const address = String(request.socket?.remoteAddress ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = address === 'localhost'
    || address === 'localhost.'
    || address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
  if (!loopback) return false;
  const site = headerOf(request, 'sec-fetch-site');
  return site === undefined || site === 'same-origin';
}

/** Send a JSON body with no caching. */
function sendJson(response, status, value) {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  } catch {
    /* headers already sent — nothing left to do */
  }
  response.end(JSON.stringify(value));
}

/**
 * Serve the picker catalog out of one agent's view, read-only.
 *
 * The panel cannot enumerate anything itself: tools and skills live on the Host
 * plane and the browser only owns the slot tree. So the Host publishes one GET
 * route and the panel fetches it, the same channel dsh-favorites uses.
 *
 * The tool list deliberately unions three sources because each is incomplete in
 * a measured way: `schemas()` at the Host plane, `schemas(agent)` per live agent
 * (which under-reports on its own), and every name the rules mention or a seal
 * already carries — so the picker always shows what is configured even when the
 * registry enumeration missed it, and an unchecked name can never be hidden by a
 * reporting gap.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {() => Map<string, object>} currentRules - the live rule map.
 * @returns {void}
 */
function serveCatalog(ctx, currentRules, audit = () => {}) {
  const webServer = service(ctx, 'webServer');
  if (usableWebServer(webServer)) {
    registerCatalog(ctx, webServer, currentRules, audit);
    return;
  }
  // Not usable at this moment. `webServer` is provided by another plugin, so
  // whether it exists HERE depends on activation order, and the measured failure
  // is exactly that race: the panel then fetched a path nobody registered, the
  // server answered its generic plain-text 404 `not found`, and the panel showed
  // `Unexpected token 'o', "not found" is not valid JSON` with an empty picker.
  // Masking itself never touches this service, so giving up on the route must
  // not be the end of the story either: `ctx.inject` is cordis' own deferred
  // activation — the callback is unloaded and re-run when the service changes,
  // and its effects belong to that sub-fiber, so the route registers the moment
  // the service appears and unwinds with our plugin. No polling, no timer.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (deferred) => {
      const late = service(deferred, 'webServer');
      if (usableWebServer(late)) {
        registerCatalog(deferred, late, currentRules, audit);
        return;
      }
      warnOnce(ctx, 'webServer stayed unusable; the masking panel has no catalog route');
      // Only the NOT-working branches are audited. A healthy registration is
      // silent, exactly like a mask that hides nothing: an untouched profile
      // must write nothing at all, and a line per host start would bury the
      // one record anyone ever reads.
      audit({ event: 'route', stage: 'absent', why: 'webServer never became usable' });
    });
    return;
  }
  warnOnce(ctx, 'no webServer service and no ctx.inject; the masking panel has no catalog route');
  audit({ event: 'route', stage: 'absent', why: 'no webServer service and no ctx.inject' });
}

/** Whether this service value can host the panel's route. */
function usableWebServer(webServer) {
  return webServer !== undefined && webServer !== null && typeof webServer.register === 'function';
}

/** Register the catalog route on the given context, owning the disposer there. */
function registerCatalog(ctx, webServer, currentRules, audit) {
  ctx.effect(() => {
    try {
      const disposer = webServer.register({
        kind: 'exact',
        path: `${API_PREFIX}/catalog`,
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            sendJson(response, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          if (!isLocalPage(request)) {
            // A machine-readable code, not prose: this is the only host string
            // that can reach the panel's UI, and the host does not know the
            // page's language. The panel maps the code to its own dictionary.
            sendJson(response, 403, { ok: false, error: 'local-page-only', code: 'not-local' });
            return;
          }
          try {
            const payload = await readCatalog(ctx, currentRules());
            sendJson(response, 200, { ok: true, ...payload });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });
      return disposer;
    } catch (error) {
      // A panel that cannot open must never gate masking: record and carry on.
      warnOnce(ctx, `catalog route could not register: ${String(error?.message ?? error)}`);
      audit({ event: 'route', stage: 'failed', error: String(error?.message ?? error) });
      return () => {};
    }
  }, 'cherry-toolfilter: catalog route');
}

/**
 * The original provider/source of one currently-shadowed skill name, looked up
 * in the live seal maps WITHOUT re-discovery (our own shadow owns the name in
 * any agent view, so discovery can no longer answer). An empty snapshot means
 * the name was never discovered when it was shadowed — a dormant explicit rule.
 * @param {string} skillName - the name the registry reported as a shadow row.
 * @returns {{name: string, description: string, provider: string, source: string} | undefined}
 */
function shadowSnapshot(skillName) {
  for (const map of sealedSkills.values()) {
    const entry = map.get(skillName);
    if (entry === undefined) continue;
    return {
      name: skillName,
      description: entry.description ?? '',
      provider: entry.provider,
      source: entry.source,
    };
  }
  return undefined;
}

/**
 * Assemble the catalog. Exported for the self-test, which runs it against fake
 * services so the shape is verified without a live host.
 * @param {object} ctx - plugin context (services read through `service()`).
 * @param {Map<string, object>} rules - preset id -> rule set.
 * @returns {Promise<object>} the picker payload.
 */
export async function readCatalog(ctx, rules) {
  const tools = service(ctx, 'tools');
  const found = new Map();
  const add = (name, description) => {
    if (typeof name !== 'string' || name === '') return;
    const current = found.get(name);
    // First non-empty description wins: the per-agent views often hand back bare
    // names, and the Host plane has the text.
    if (current === undefined || (current === '' && typeof description === 'string' && description !== '')) {
      found.set(name, typeof description === 'string' ? description : '');
    }
  };

  const harvest = (schemas) => {
    for (const entry of Array.isArray(schemas) ? schemas : []) {
      add(typeof entry === 'string' ? entry : entry?.name, typeof entry === 'string' ? '' : entry?.description);
    }
  };
  /** One enumeration that may throw: a dead view contributes nothing. */
  const attempt = (read) => {
    try {
      return read();
    } catch {
      return [];
    }
  };

  harvest(attempt(() => tools?.schemas?.()));

  // Per-agent views see scope-local registrations the Host plane does not.
  for (const candidate of [...liveAgents.values()]) {
    harvest(attempt(() => tools?.schemas?.(candidate)));
  }

  // Anything configured or already sealed must be pickable.
  for (const name of DEFAULT_DENY) add(name, '');
  for (const entry of rules.values()) {
    for (const name of entry.tools.deny) add(name, '');
    for (const name of entry.skills.denyNames) add(name, '');
  }

  // Skills are layered host + per-scope, and a project's skills only appear in a
  // view that has that project's cwd. So: the host plane plus ONE live agent (the
  // panel is a machine-wide picker, not a per-session one, and discovery reads the
  // filesystem — unioning every agent would repeat that work for nothing).
  const skills = service(ctx, 'skills');
  const discovered = new Map();
  const lookups = [{ scope: undefined }];
  const oneAgent = [...liveAgents.values()][0];
  if (oneAgent !== undefined) {
    const cwd = oneAgent.session?.header?.cwd;
    lookups.push({ scope: oneAgent, ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}) });
  }
  for (const lookup of lookups) {
    try {
      const summaries = await skills?.list?.(lookup);
      for (const entry of Array.isArray(summaries) ? summaries : []) {
        if (typeof entry?.name !== 'string' || entry.name === '') continue;
        // Our own shadow wins the name in an agent-scoped view (that is the
        // mask working). Take the shadow row's place with the ORIGINAL
        // provider/source snapshot stored at shadow time, so a masked project
        // skill still shows up with its real source tag instead of vanishing
        // from the picker — and never with the shadow's fake non-invocation,
        // which would read to the panel as "SkillsManager has this switched
        // off". Only names no view surfaced get the reconstructed row; a
        // global-layer view still sees the real entry and wins.
        if (entry.provider === SHADOW_PROVIDER || entry.source === SHADOW_PROVIDER) {
          if (!discovered.has(entry.name)) {
            const original = shadowSnapshot(entry.name);
            if (original !== undefined) discovered.set(entry.name, original);
          }
          continue;
        }
        if (!discovered.has(entry.name)) discovered.set(entry.name, entry);
      }
    } catch {
      /* a view that cannot discover simply contributes nothing */
    }
  }
  // SkillsManager owns the global switch, and its state reaches the registry as
  // the `invocation` flags. This picker is the per-mode switch layered on top,
  // so it lists only what is globally enabled — hiding something already off is
  // not a control, it is noise. A configured rule that points at a currently
  // disabled skill stays listed (checked, tagged) so the panel can never
  // silently drop a rule the user authored.
  const configuredNames = new Set();
  for (const entry of rules.values()) for (const name of entry.skills.denyNames) configuredNames.add(name);
  const skillRows = [...discovered.values()]
    .filter((entry) => skillMaskable(entry) || configuredNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      source: typeof entry.source === 'string' ? entry.source : '',
      enabled: skillMaskable(entry),
    }));

  let presets = [];
  try {
    const registry = service(ctx, 'agentPresets');
    const listed = await registry?.list?.();
    if (Array.isArray(listed)) presets = listed.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter((id) => typeof id === 'string' && id !== '');
  } catch {
    presets = [];
  }

  // Who is masked right now, so the panel can mark live state per agent.
  const sealedBy = {};
  for (const [agentId, map] of sealedTools) sealedBy[agentId] = [...map.keys()];

  const mcpServers = [];
  for (const name of found.keys()) {
    const server = mcpServer(name);
    if (server !== undefined && !mcpServers.includes(server)) mcpServers.push(server);
  }

  // Discovery roots come from what the registry actually reported, plus anything a
  // rule already names: SKILL_SOURCES is only a label table, never the vocabulary.
  const observedSources = new Set(skillRows.map((entry) => entry.source).filter((id) => id !== ''));
  for (const entry of rules.values()) for (const id of entry.skills.denySources) observedSources.add(id);
  const skillSourceRows = [...observedSources].sort().map((id) => ({ id, label: sourceLabel(id) }));

  // Ownership comes from the cached package scan, never from a guessed category.
  const owners = provenanceFor(ctx)
  const grouped = groupByOwner([...found.keys()], owners.scan?.literal ?? {})
  const toolRows = []
  for (const [group, list] of Object.entries(grouped)) {
    for (const entry of list) {
      const description = found.get(entry.name) ?? ''
      toolRows.push({ name: entry.name, description, group, owner: entry.owner })
    }
  }
  toolRows.sort((a, b) => a.name.localeCompare(b.name))

  // The rule map as the ENGINE holds it, so the panel renders what masking does
  // instead of re-implementing buildRules/legacy folding in a realm that cannot
  // import it. This is the same object the mask is driven from: the baseline fold
  // into cherry and the v1 `presetId`+`deny` merge are already applied here.
  //
  // The `*` entry stays its OWN block, exactly as `rulesFor` keeps it separate:
  // the effective rules for a preset are its block UNIONED with `*` at lookup
  // time. The panel relies on that — it renders `*`'s names as checked-but-locked
  // in every other view, which is only honest while the two blocks remain
  // distinct. Flattening them here would make `*` cosmetic after one save.
  const stored = {}
  for (const [presetId, entry] of rules) {
    stored[presetId] = {
      tools: { deny: [...entry.tools.deny], denyPrefix: [...entry.tools.denyPrefix] },
      skills: {
        denyNames: [...entry.skills.denyNames],
        denyProviders: [...entry.skills.denyProviders],
        denySources: [...entry.skills.denySources],
      },
    }
  }

  return {
    ownerGroups: Object.entries(OWNER_GROUPS).map(([id, label]) => ({ id, label })),
    provenance: { scannedAt: owners.scannedAt, scanning: owners.scanning },
    skillSources: skillSourceRows,
    presets,
    stored,
    mcpServers,
    sealedBy,
    tools: toolRows,
    skills: skillRows.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The provenance scan state, at module scope so a scan survives a plugin
 * remount and only one worker ever runs.
 *
 * The catalog NEVER waits for a scan: reading thousands of package files costs
 * seconds and the Host loop must not stall for a settings panel. So this serves
 * whatever the disk cache holds, and kicks a worker thread to refresh it in the
 * background when the cache is missing or stale. The panel shows owners as soon
 * as the cache exists and can say "正在识别来源" while it does not.
 */
const provenanceState = {
  /** @type {object | undefined} the last scan result. */
  scan: undefined,
  /** @type {number} when that scan was produced. */
  scannedAt: 0,
  /** @type {boolean} whether a worker is running right now. */
  scanning: false,
  /** @type {string} the installed-set key the cached scan belongs to. */
  key: '',
  /**
   * @type {number} when a scan last FAILED, and for which key.
   *
   * A failed scan is usually persistent (an unreadable archive, a profile that
   * moved), and a scan costs seconds of worker time, so retrying it on every
   * catalog request would burn a thread per panel open. One retry per key after
   * SCAN_RETRY_MS is enough: installing a bundle changes the key and retries
   * immediately.
   */
  failedAt: 0,
  failedKey: '',
}

/** How long to hold off after a failed scan before trying again. */
const SCAN_RETRY_MS = 5 * 60 * 1000

/**
 * Read the provenance state, starting a background refresh when needed.
 * @param {object} ctx - the plugin context.
 * @returns {{scan: object | undefined, scannedAt: number, scanning: boolean}}
 */
function provenanceFor(ctx) {
  const dir = packageDir()
  if (dir === undefined) return { scan: provenanceState.scan, scannedAt: provenanceState.scannedAt, scanning: provenanceState.scanning }
  const profileDir = profileDirectory(ctx)
  const archive = asarPath()
  let key
  try {
    // The archive is part of the key, and the SAME resolved value is handed to
    // the scan below: a cache keyed on archive X must never be satisfied by a
    // scan of archive Y.
    key = cacheKey(profileDir, archive)
  } catch {
    return { scan: provenanceState.scan, scannedAt: provenanceState.scannedAt, scanning: provenanceState.scanning }
  }
  // Nothing to scan: no shipped archive in reach AND an empty package set, which
  // means the directory we resolved is not a profile at all (a CLI run from a
  // source tree, a test, a bare script). Ownership is honestly reported as
  // unknown and no worker thread is started. A real profile always has one or
  // the other, and the archive being part of the key is what keeps a test-run
  // scan from ever being read as the host's.
  if (archive === undefined && key.endsWith('\n')) return { scan: undefined, scannedAt: 0, scanning: false }
  if (key !== provenanceState.key || provenanceState.scan === undefined) {
    const cached = readCache(dir, key)
    if (cached !== undefined) {
      provenanceState.scan = cached.scan
      provenanceState.scannedAt = cached.scannedAt
      provenanceState.key = key
    } else if (provenanceState.scanning === false
      && !(provenanceState.failedKey === key && Date.now() - provenanceState.failedAt < SCAN_RETRY_MS)) {
      provenanceState.scanning = true
      provenanceState.key = key
      runProvenanceScan(dir, profileDir, ctx, archive)
    }
  }
  return { scan: provenanceState.scan, scannedAt: provenanceState.scannedAt, scanning: provenanceState.scanning }
}

/**
 * The profile directory, using the same measured rule as schemastery loading:
 * `DSH_PROFILE_DIR` may be absent in an Electron host while `process.cwd()` IS
 * the profile.
 * @param {object} ctx - the plugin context (unused today, kept for parity).
 * @returns {string}
 */
function profileDirectory(ctx) {
  void ctx;
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return process.cwd()
}

/**
 * Scan in a worker thread and cache the result. Never blocks, never throws.
 *
 * The archive path is resolved ONCE by the caller and handed over: `asarPath()`
 * depends on `process.resourcesPath`, which only the Electron main process has,
 * so a worker resolving it itself would silently scan profile-only and mislabel
 * every shipped tool as third-party. Handing the same value through that built
 * the cache key is what makes "keyed on archive X, filled by a scan of archive Y"
 * unrepresentable rather than merely unlikely.
 * @param {string} cacheDir - where to write the cache.
 * @param {string} profileDir - the profile to scan.
 * @param {object} ctx - for logging only.
 * @param {string | undefined} archive - the archive the key was built for.
 */
function runProvenanceScan(cacheDir, profileDir, ctx, archive) {

  // The key this scan was started FOR. The answer is only trusted while that is
  // still the current key: installing a bundle mid-scan changes the key, and
  // filing a result computed against the OLD package set under the NEW key would
  // serve owners that no longer match the machine.
  const scanKey = provenanceState.key
  const markFailed = () => {
    provenanceState.failedAt = Date.now()
    provenanceState.failedKey = scanKey
  }
  let worker
  try {
    worker = new Worker(new URL('./provenance-worker.js', import.meta.url), {
      workerData: { profileDir, archive },
    })
  } catch (error) {
    provenanceState.scanning = false
    markFailed()
    warnOnce(ctx, `provenance worker could not start: ${String(error?.message ?? error)}`)
    return
  }
  const settle = () => {
    provenanceState.scanning = false
  }
  worker.once('message', (message) => {
    settle()
    if (message?.ok !== true || message.scan === undefined) {
      markFailed()
      warnOnce(ctx, `provenance scan failed: ${String(message?.error ?? 'unknown')}`)
      return
    }
    if (provenanceState.key !== scanKey) {
      // The machine changed under the scan; drop it and let the next request
      // start a fresh one for the current key.
      provenanceState.failedKey = ''
      return
    }
    provenanceState.scan = message.scan
    provenanceState.scannedAt = message.started
    provenanceState.failedAt = 0
    provenanceState.failedKey = ''
    writeCache(cacheDir, scanKey, message.scan)
    try {
      ctx.logger?.info?.(`cherry-toolfilter: tool provenance scanned (${Object.keys(message.scan.literal ?? {}).length} names, ${message.tookMs}ms)`)
    } catch {
      /* logging is optional */
    }
  })
  worker.once('error', (error) => {
    settle()
    markFailed()
    warnOnce(ctx, `provenance worker error: ${String(error?.message ?? error)}`)
  })
  worker.once('exit', (code) => {
    settle()
    // An exit without ever answering (crash, kill, non-zero) is a failure too.
    if (code !== 0) markFailed()
  })
  // A scan that never answers must not hold the flag forever.
  const guard = setTimeout(() => {
    settle()
    markFailed()
    try {
      worker.terminate()
    } catch {
      /* already gone */
    }
  }, 120_000)
  worker.once('exit', () => clearTimeout(guard))
}

/** Warn at most once per message so a missing route cannot spam the log. */
const warned = new Set();
function warnOnce(ctx, message) {
  if (warned.has(message)) return;
  warned.add(message);
  try {
    ctx.logger?.warn?.(`cherry-toolfilter: ${message}`);
  } catch {
    /* logging must never break activation */
  }
}

/**
 * Translate the accepted config shapes into the rules input.
 *
 * v1: `{ presetId?, deny }`. v2: `{ defaults?, presets? }`. Mixed is fine. v1's
 * `deny` without a `presetId` meant the cherry preset, so it still does.
 *
 * Exported because the catalog's `stored` map — the ONLY thing the masking panel
 * renders — must come from this exact function, and the closure proof must be
 * able to run the same implementation the host runs rather than a copy that can
 * drift.
 * @param {object} cfg - the raw row config.
 * @returns {{defaults: boolean | undefined, presets: object}} rules input.
 */
export function toRulesConfig(cfg) {
  const presets = { ...(cfg.presets ?? {}) };
  if (Array.isArray(cfg.deny) && cfg.deny.length > 0) {
    const presetId = typeof cfg.presetId === 'string' && cfg.presetId !== '' ? cfg.presetId : DEFAULT_PRESET;
    const own = presets[presetId] ?? {};
    presets[presetId] = {
      ...own,
      tools: { ...(own.tools ?? {}), deny: [...(own.tools?.deny ?? []), ...cfg.deny] },
    };
    if (cfg.defaults !== undefined) return { defaults: cfg.defaults, presets };
    // v1 semantics: the given list IS the mask. For cherry an explicit list
    // replaces the baseline anyway; for a foreign preset `false` also stops
    // the baseline from attaching to it through the default map.
    return { defaults: presetId === DEFAULT_PRESET ? undefined : false, presets };
  }
  return { defaults: cfg.defaults, presets };
}

/**
 * Narrow the tool and skill surface of one Agent per the configured rules.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} [config] - row configuration, see lib/rules.js `buildRules`.
 *   Legacy v1 fields `presetId` and `deny` are still accepted and folded into
 *   a rules map, so an existing row config keeps working unchanged.
 */
export function apply(ctx, config = {}) {
  /**
   * The current rule map, rebuilt whenever the row configuration changes.
   * Every config field is a volatile cell (or a plain value on older hosts),
   * so reading through `liveValue` at use time — not at mount time — is what
   * makes a settings edit take effect without a remount.
   */
  let rules = buildRules(toRulesConfig(readConfig()));

  /** Read the whole row config with volatile cells unwrapped. */
  function readConfig() {
    return {
      defaults: liveValue(config.defaults),
      presets: liveValue(config.presets),
      presetId: liveValue(config.presetId),
      deny: liveValue(config.deny),
      audit: liveValue(config.audit),
    };
  }

  const cfgAudit = () => readConfig().audit;

  /**
   * Where the audit line goes for the current config, or undefined when
   * disabled. Resolved per record so `audit: false` stops writes live.
   */
  const auditTarget = () => {
    const audit = cfgAudit();
    if (audit === false) return undefined;
    if (typeof audit === 'string' && audit !== '') return audit;
    const dir = packageDir();
    return dir === undefined ? undefined : join(dir, AUDIT_FILE);
  };

  /** Record one decision when an audit target is configured. */
  const audit = (entry) => {
    const file = auditTarget();
    if (file !== undefined) record(file, entry);
  };

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`cherry-toolfilter: ${message}`);
    } catch {
      /* logging must never break session creation */
    }
  };

  /** Agents this plugin is finished with, so `pre-step` stops looking at them. */
  const settled = new Set();
  /** Late passes already spent per Agent, so a stubborn name cannot loop forever. */
  const passes = new Map();
  /** Preset-matched live Agents, so a registry change knows whom to re-check. */
  const targets = new Map();
  /** Every Agent this plugin has ever evaluated, target or not, so a rules
   * edit can un-settle one that a NEWLY added preset rule now covers. */
  const seen = new Set();
  /** Re-checks bought by registry changes per Agent, bounded against churn. */
  const rechecks = new Map();

  /** How many registry-change re-checks one Agent may buy before the plugin stops. */
  const MAX_RECHECKS = 16;

  /** Agents currently inside a mask pass, so self-triggered events coalesce. */
  const inPass = new Set();
  /** One pending re-check owed to events that arrived while a pass was running. */
  const pendingRecheck = new Set();

  /**
   * A registry change means a late registration may now be maskable: un-settle
   * the target Agents, bounded per Agent so a flapping provider cannot buy
   * unbounded work.
   *
   * Two event classes, two treatments. Our own successful `restrict()` calls
   * emit `tools/change` synchronously INSIDE the pass: those coalesce to one
   * owed re-check per pass (applied unthrottled when the pass ends), because
   * an unsettled Agent mid-retry needs no un-settle — left to themselves,
   * 35 masked names would spend the whole budget on self-churn. Events from
   * outside a running pass are the real signal (an MCP server finishing
   * registration) and buy re-checks directly, with a short leading-edge
   * throttle so one burst of external events costs one re-check, not thousands.
   * A burst's first event un-settles the Agent, and its next step pass sees
   * every registration that landed before the pass began — nothing is lost.
   */
  const buyRecheck = (id) => {
    const spent = rechecks.get(id) ?? 0;
    if (spent >= MAX_RECHECKS) return;
    rechecks.set(id, spent + 1);
    settled.delete(id);
    passes.delete(id);
  };
  const RECHECK_WINDOW_MS = 1000;
  let recheckWindow = 0;
  const recheck = () => {
    let external = false;
    for (const id of targets.keys()) {
      if (inPass.has(id)) pendingRecheck.add(id);
      else external = true;
    }
    if (!external) return;
    const now = Date.now();
    if (now < recheckWindow) return;
    recheckWindow = now + RECHECK_WINDOW_MS;
    for (const id of targets.keys()) {
      if (!inPass.has(id)) buyRecheck(id);
    }
  };
  ctx.on('tools/change', recheck);
  ctx.on('skills/change', recheck);

  // The masking panel lists real names, not a hardcoded guess: it fetches this
  // read-only route. Registered before any rule exists so an empty configuration
  // still opens a full picker. The audit records which branch was taken, so a
  // dead panel has durable evidence of WHY (the logger goes to stdout and is
  // gone by the time anyone asks).
  serveCatalog(ctx, () => rules, audit);

  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent?.id ?? '?');
    targets.delete(id);
    passes.delete(id);
    rechecks.delete(id);
    pendingRecheck.delete(id);
    seen.delete(id);
    // The catalog holds a strong reference to every tracked Agent; the comment
    // on `liveAgents` promised this prune and the handler never did it, so a
    // disposed agent stayed reachable (and got its `schemas()` called from the
    // route) until LRU eviction.
    liveAgents.delete(id);
    // Seals were applied through agent.ctx, so their effects live on the
    // AGENT's fiber and unwind with it — nothing to call, only to forget.
    sealedTools.delete(id);
    sealedSkills.delete(id);
    shadowHandles.delete(id);
    // Silence permanently: out of `targets` so a registry change cannot
    // re-check it, marked settled so a stray step cannot re-masks it either.
    settled.add(id);
  });

  // A session can commit a different preset mid-life (agent-preset/selected).
  // An agent settled as "not a target" must be reconsidered on the next step
  // after such a switch — drop the stale verdict (agent id is the session id).
  ctx.on('agent-preset/selected', (sessionId) => {
    const id = String(sessionId ?? '?');
    settled.delete(id);
    passes.delete(id);
    rechecks.delete(id);
  });

  // A settings edit rewrites the volatile cells in place without remounting
  // this plugin (the loader emits `loader/volatile-update` when it does).
  // Rebuild the rule map and un-settle every live agent so its next pass
  // applies the new rules both ways — sealing fresh matches and lifting
  // stale ones — instead of waiting for a restart or a new session.
  ctx.on('loader/volatile-update', () => {
    rules = buildRules(toRulesConfig(readConfig()));
    for (const id of seen) {
      settled.delete(id);
      passes.delete(id);
    }
  });

  /**
   * Lift every seal this plugin placed on one agent and forget the agent.
   * @param {string} id - the agent id.
   */
  const releaseAgent = (id) => {
    const tools = sealedTools.get(id);
    if (tools !== undefined) {
      for (const disposer of tools.values()) {
        try {
          disposer();
        } catch {
          /* its fiber may already be gone; the seal dies with it */
        }
      }
      sealedTools.delete(id);
    }
    // Skills share ONE provider registration per agent, so releasing is:
    // forget every shadowed name (the provider reads the live set, so the
    // next discovery drops them) and dispose the registration itself.
    const handle = shadowHandles.get(id);
    if (handle?.current !== undefined) {
      try {
        handle.current.dispose();
      } catch {
        /* same */
      }
    }
    shadowHandles.delete(id);
    sealedSkills.delete(id);
  };

  /**
   * Run one mask pass for one Agent and record the outcome.
   * @param {object} agent - the live Agent.
   * @param {'created' | 'pre-step'} stage - which hook spoke.
   * @param {AbortSignal | undefined} signal - the step's cancellation, if any.
   * @returns {Promise<object | undefined>} the pass record, or undefined when skipped.
   */
  const maskFor = async (agent, stage, signal) => {
    if (agent === undefined || agent.ctx === undefined) return undefined;

    const id = String(agent.id ?? '?');
    seen.add(id);
    trackAgent(id, agent);
    const preset = presetOf(ctx, agent);
    const agentRules = rulesFor(rules, preset.id);
    if (agentRules === undefined || rulesEmpty(agentRules)) {
      // Not a configured preset. If we ever sealed anything here, the rules
      // were removed or the session switched presets — lift it all, then
      // settle on sight so every later step is a Set lookup and nothing is
      // ever written about it.
      // NOTE (checked, do not "fix" again): `sealedTools.has(id)` alone
      // already covers the shadow provider — maskFor creates the tool map
      // unconditionally on every pass that can place a shadow, so an agent
      // with a live handle ALWAYS has this entry. There is no leak path here.
      if (sealedTools.has(id) || sealedSkills.has(id)) {
        releaseAgent(id);
        audit({ agent: id, stage, event: 'released', preset: preset.id ?? null });
      }
      settled.add(id);
      return undefined;
    }

    const base = { agent: id, target: preset.id, stage };
    targets.set(id, agent);
    let ownTools = sealedTools.get(id);
    if (ownTools === undefined) {
      ownTools = new Map();
      sealedTools.set(id, ownTools);
    }
    let ownSkills = sealedSkills.get(id);
    if (ownSkills === undefined) {
      ownSkills = new Map();
      sealedSkills.set(id, ownSkills);
    }
    let ownHandle = shadowHandles.get(id);
    if (ownHandle === undefined) {
      ownHandle = { current: undefined };
      shadowHandles.set(id, ownHandle);
    }

    const scopedTools = service(agent.ctx, 'tools');
    const tools = scopedTools ?? service(ctx, 'tools');
    if (tools === undefined || typeof tools.restrict !== 'function') {
      warn('no tools service with restrict(); nothing was masked');
      audit({ ...base, event: 'failed', preset: preset.id, why: 'no tools service' });
      settled.add(id);
      return undefined;
    }

    // Exact names are requested directly; prefix rules are expanded through the
    // visible-name hint list (see visibleNames for why that list is trusted only
    // as a hint).
    const denyNames = [...agentRules.tools.deny];
    if (agentRules.tools.denyPrefix.length > 0) {
      for (const name of visibleNames(tools, agent)) {
        if (matchTool(name, { deny: [], denyPrefix: agentRules.tools.denyPrefix }) && !denyNames.includes(name)) denyNames.push(name);
      }
    }
    const toolResult = applyDeny(tools, denyNames, ownTools, warn);
    // Seals whose rule disappeared since the last pass (settings edit, bundle
    // remount, preset switch) are lifted now — same-session, immediate.
    const lifted = liftStale(agentRules, ownTools, ownSkills, warn);
    // A lifted name disappears from the provider's live set, so the registry
    // cache must be busted for the catalog to show it again.
    if (lifted.skillsLifted.length > 0) ownHandle.current?.invalidate();

    const scopedSkills = scopedService(ctx, agent, 'skills');
    let skillResult;
    if (stage !== 'pre-step') {
      // Skill discovery reads the filesystem through the provider chain, and
      // `agent/created` is awaited before the session is published. The catalog
      // is only rendered in a step, so the first `pre-step` pass does this work
      // instead: a session that never sends a message never shows a catalog, so
      // shadowing there would cost creation latency to buy nothing.
      skillResult = undefined;
    } else if (scopedSkills === undefined || typeof scopedSkills.registerProvider !== 'function' || typeof scopedSkills.list !== 'function') {
      if (agentRules.skills.denyNames.length + agentRules.skills.denyProviders.length + agentRules.skills.denySources.length > 0) {
        warn('no usable skills service for this agent; skill rules were not applied');
      }
      skillResult = undefined;
    } else {
      try {
        const workingDirectory = service(ctx, 'workingDirectory');
        const cwd = await Promise.resolve(
          workingDirectory?.ensure?.(agent, signal) ?? agent.session?.header?.cwd,
        ).catch(() => undefined);
        const lookup = {
          scope: agent,
          ...(cwd === undefined || typeof cwd !== 'string' ? {} : { cwd }),
          ...(signal === undefined ? {} : { signal }),
        };
        skillResult = await shadowSkills(scopedSkills, agentRules, lookup, ownSkills, warn, ownHandle);
      } catch (error) {
        warn(`skill discovery pass failed: ${String(error)}`);
        skillResult = { error: String(error) };
      }
    }

    audit({
      ...base,
      event: 'masked',
      preset: preset.id,
      composed: preset.composed ?? null,
      declared: preset.declared ?? null,
      scoped: scopedTools !== undefined,
      tools: toolResult,
      ...(skillResult === undefined ? {} : { skills: skillResult }),
      ...(lifted.toolsLifted.length + lifted.skillsLifted.length === 0 ? {} : { lifted }),
    });
    if (toolResult.masked.length > 0) {
      ctx.logger?.info?.(
        `cherry-toolfilter: masked ${toolResult.masked.length} host tool(s) for preset "${preset.id}" (${stage})`,
      );
    }

    // Settlement rule. A name that is not registered yet throws as unknown, so an
    // early pass reports it as refused and cannot settle the Agent: the tools this
    // plugin targets on this machine (`automation_*`, `plugin_manager`) register
    // after `agent/created` returns. Later passes retry until nothing is refused,
    // or until the Agent has spent its passes — a name that never registers must
    // stop costing every step. A failed discovery pass (skillResult.error) and a
    // shadow provider that could not register (skillResult.failed) keep the Agent
    // unsettled for the same reason: both are things that can become possible.
    if (stage === 'pre-step') {
      const clean = (toolResult.refused ?? []).length === 0
        && skillResult?.error === undefined
        && skillResult?.failed === undefined;
      const spent = (passes.get(id) ?? 0) + 1;
      passes.set(id, spent);
      if (clean || spent >= MAX_PASSES) {
        if (!clean) {
          warn(`giving up on ${id} after ${spent} pass(es); refused: ${(toolResult.refused ?? []).join(', ') || 'none'}${skillResult?.error ? ` skills: ${skillResult.error}` : ''}${skillResult?.failed ? ` shadow provider refused: ${skillResult.failed.join(', ')}` : ''}`);
        }
        settled.add(id);
      }
    }
    return { tools: toolResult, skills: skillResult };
  };

  /** Run one stage with a guard that can never fail the session. */
  const guarded = (agent, stage, signal) => {
    const id = String(agent?.id ?? '?');
    inPass.add(id);
    return maskFor(agent, stage, signal)
      .catch((error) => {
        /* A throw here fails the turn; the mask is an optimization, never a gate. */
        warn(`${stage} hook failed: ${String(error)}`);
        audit({ agent: id, stage, event: 'failed', error: String(error) });
        settled.add(id);
      })
      .then(() => {
        // The pass is over: coalesced self-events settle as ONE owed re-check.
        inPass.delete(id);
        if (pendingRecheck.delete(id)) buyRecheck(id);
      });
  };

  ctx.on('agent/created', ({ agent, signal }) => {
    // A resumed session re-creates the SAME id on a NEW fiber. Every verdict
    // keyed by that id belonged to the disposed fiber: its seals died with it,
    // skill shadows are only ever placed in a pre-step pass, and a settled
    // entry means that pass never runs again. Measured before this existed:
    // create → dispose → resume left the session with NO shadows and no late-
    // registration retry, permanently. Drop the stale verdicts first.
    const id = String(agent?.id ?? '?');
    settled.delete(id);
    passes.delete(id);
    rechecks.delete(id);
    pendingRecheck.delete(id);
    return guarded(agent, 'created', signal);
  });

  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload?.agent;
    if (agent === undefined || settled.has(String(agent.id ?? '?'))) return next();
    return guarded(agent, 'pre-step', payload?.signal).then(() => next());
  });
}
