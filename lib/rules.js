/**
 * Pure rule matching for cherry-toolfilter.
 *
 * Kept free of any @deepseek-ai import: this package is installed through the
 * pnpm `link:` protocol, and a bare import of a host-only package would not
 * resolve at runtime from outside the installation tree. Everything here works
 * on plain data so it can be unit-tested with node alone.
 *
 * A "rule set" for one agent preset is the merged shape:
 *
 *   {
 *     tools:  { deny: string[], denyPrefix: string[] },
 *     skills: { denyNames: string[], denyProviders: string[], denySources: string[] },
 *   }
 *
 * `deny`/`denyNames` are exact names. `denyPrefix` targets the stable identity
 * embedded in MCP public names (`mcp__<server>__<raw>`), so `"mcp__github__"`
 * hides every tool of that server. `denyProviders`/`denySources` match the
 * `provider`/`source` metadata the skill registry attaches to every summary.
 */

/** The single agent preset this plugin narrows when nothing else is configured. */
export const DEFAULT_PRESET = 'cherry';

/**
 * Built-in host tools hidden from the cherry preset. This is the historical
 * default surface; it stays the cherry baseline so upgrading the plugin does not
 * silently change an unconfigured cherry session. A request, not a command: a
 * name whose owning bundle is absent is simply refused by the registry and skipped.
 */
export const DEFAULT_DENY = [
  // persistent PTY sessions
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
  // scheduled tasks
  'automation_create',
  'automation_list',
  'automation_update',
  'automation_runs',
  'automation_run_now',
  'automation_delete',
  // session archaeology
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  // bundle management
  'plugin_manager',
  // one-off extras
  'ralph',
  'pua_reference',
  'dsh_code_review',
  // web/search variants that duplicate the kept ones
  'weather',
  'video_search',
  'cache_search',
  'domain_search',
  'free_search_test',
];

/**
 * The MCP server a public tool name belongs to, or undefined.
 * `mcp__<server>__<raw>` — the server segment is the stable identity, so one
 * prefix rule hides every tool of that server.
 * @param {string} name - public tool name.
 * @returns {string | undefined} the server name.
 */
export function mcpServer(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const index = rest.indexOf('__');
  return index > 0 ? rest.slice(0, index) : undefined;
}

/** The `*` preset key: rules applied to every narrowed preset, merged under its own. */
export const WILDCARD = '*';

/** Return only the non-empty strings of a list, defensively. */
function clean(list) {
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry !== '') : [];
}

/** Union two string lists preserving first-seen order. */
function union(a, b) {
  const out = [];
  const seen = new Set();
  for (const entry of [...a, ...b]) {
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Build the per-preset rule map from the plugin `config` object.
 *
 * `config` shape (all optional; anything missing falls back to defaults):
 *   {
 *     defaults?: boolean | undefined,           // tri-state, see below
 *     presets?: Record<string, {
 *       tools?:  { deny?: string[], denyPrefix?: string[] },
 *       skills?: { denyNames?: string[], denyProviders?: string[], denySources?: string[] },
 *     }>
 *   }
 *
 * Whether the built-in cherry baseline folds in is decided by one honest signal:
 * does the cherry block carry its OWN `tools.deny` array? A written list — even an
 * EMPTY one — means somebody spoke about tools, and what they said stands. Its
 * absence means tools were never addressed (a YAML block that only hides skills,
 * or no cherry block at all), and then the baseline applies. This is what lets
 * the panel's "uncheck everything" survive instead of resurrecting 25 hidden
 * tools behind an empty selection.
 *
 * `defaults` still overrides that reading: `true` folds the baseline in
 * regardless, `false` never folds it in.
 * @param {object} config - raw row configuration.
 * @param {boolean | undefined} config.defaults - baseline policy.
 * @param {Record<string, object>} [config.presets] - preset id -> partial rules.
 * @returns {Map<string, object>} preset id -> full rule set.
 */
export function buildRules({ defaults, presets = {} } = {}) {
  const map = new Map();
  const source = presets && typeof presets === 'object' ? presets : {};
  for (const [presetId, partial] of Object.entries(source)) {
    map.set(presetId, normalizeRules(partial));
  }
  const baseline = normalizeRules({ tools: { deny: DEFAULT_DENY } });
  const cherry = map.get(DEFAULT_PRESET);
  if (defaults === false) return map;
  if (defaults === true) {
    if (cherry === undefined) map.set(DEFAULT_PRESET, baseline);
    else cherry.tools.deny = union(baseline.tools.deny, cherry.tools.deny);
    return map;
  }
  if (cherry === undefined) map.set(DEFAULT_PRESET, baseline);
  else if (!Array.isArray(source[DEFAULT_PRESET]?.tools?.deny)) cherry.tools.deny = baseline.tools.deny;
  return map;
}

/**
 * Normalize one preset's partial rule object into the full shape.
 *
 * `null` is a legal YAML value for an empty block (`cherry:` with nothing under
 * it), so it must normalize to an empty rule set rather than throw — a throw
 * here happened inside `readCatalog`, which turned one malformed row into a
 * dead route and therefore a panel that could not open at all.
 * @param {object | null | undefined} partial - one preset's block.
 * @returns {{tools: {deny: string[], denyPrefix: string[]}, skills: {denyNames: string[], denyProviders: string[], denySources: string[]}}}
 */
export function normalizeRules(partial) {
  const block = partial !== null && typeof partial === 'object' ? partial : {};
  const tools = block.tools !== null && typeof block.tools === 'object' ? block.tools : {};
  const skills = block.skills !== null && typeof block.skills === 'object' ? block.skills : {};
  return {
    tools: { deny: clean(tools.deny), denyPrefix: clean(tools.denyPrefix) },
    skills: {
      denyNames: clean(skills.denyNames),
      denyProviders: clean(skills.denyProviders),
      denySources: clean(skills.denySources),
    },
  };
}

/**
 * Resolve the effective rule set for one preset id: the preset's own rules
 * unioned with the `*` wildcard. An unlisted preset has NO rules, even when a
 * wildcard is configured — the wildcard widens presets the user opted in, it
 * does not opt every preset into masking. This keeps an untouched mode exactly
 * as cheap as a profile without this bundle.
 * @param {Map<string, object>} rules - from {@link buildRules}.
 * @param {string | undefined} presetId - the agent's composed/declared preset.
 * @returns {object | undefined} merged rules, or undefined for an untouched preset.
 */
export function rulesFor(rules, presetId) {
  if (typeof presetId !== 'string' || presetId === '') return undefined;
  const own = rules.get(presetId);
  if (own === undefined) return undefined;
  const wildcard = rules.get(WILDCARD);
  if (wildcard === undefined) return own;
  return {
    tools: { deny: union(own.tools.deny, wildcard.tools.deny), denyPrefix: union(own.tools.denyPrefix, wildcard.tools.denyPrefix) },
    skills: {
      denyNames: union(own.skills.denyNames, wildcard.skills.denyNames),
      denyProviders: union(own.skills.denyProviders, wildcard.skills.denyProviders),
      denySources: union(own.skills.denySources, wildcard.skills.denySources),
    },
  };
}

/** Whether a rule set has anything to hide. */
export function rulesEmpty(rules) {
  return rules.tools.deny.length === 0
    && rules.tools.denyPrefix.length === 0
    && rules.skills.denyNames.length === 0
    && rules.skills.denyProviders.length === 0
    && rules.skills.denySources.length === 0;
}

/**
 * Whether one tool name should be hidden.
 * @param {string} name - public tool name.
 * @param {object} tools - { deny: string[], denyPrefix: string[] }.
 * @returns {boolean}
 */
export function matchTool(name, tools) {
  if (tools.deny.includes(name)) return true;
  return tools.denyPrefix.some((prefix) => name.startsWith(prefix));
}

/**
 * Whether one skill summary should be hidden, judged by its source metadata.
 * @param {{ name: string, provider?: string, source?: string }} skill - a registry summary.
 * @param {object} skills - { denyNames, denyProviders, denySources } string lists.
 * @returns {boolean}
 */
export function matchSkill(skill, skills) {
  if (skills.denyNames.includes(skill.name)) return true;
  if (typeof skill.provider === 'string' && skills.denyProviders.includes(skill.provider)) return true;
  if (typeof skill.source === 'string' && skills.denySources.includes(skill.source)) return true;
  return false;
}

/**
 * Whether one registry summary is a skill the machine currently has ON, i.e. a
 * candidate for FURTHER masking.
 *
 * SkillsManager is the global switch: it registers a provider whose candidates
 * carry `invocation.modelInvocable` / `userInvocable` resolved from its own
 * state file (a skill the user turned off there is reported with both flags
 * false — `@michengai/dsh-skills-manager` core.js `listProviderCandidates` +
 * `effectiveSkillPolicy`). This plugin is the per-mode switch layered on top,
 * so it must only act on skills that are globally enabled: masking something
 * already off is redundant work, and offering it in the picker reads as a
 * control that does nothing.
 *
 * The gate is a NOT-false test, never an IS-true test: a skill the host registry
 * reports with no `invocation` object (a bundled/native skill on a machine
 * without SkillsManager) defaults to enabled and stays maskable, so this never
 * regresses the no-SkillsManager case.
 * @param {{ invocation?: { modelInvocable?: boolean, userInvocable?: boolean } }} skill - a registry summary.
 * @returns {boolean} whether it is currently enabled and therefore maskable.
 */
export function skillMaskable(skill) {
  const invocation = skill?.invocation;
  if (invocation === undefined || invocation === null) return true;
  return invocation.modelInvocable !== false && invocation.userInvocable !== false;
}

/**
 * Best-effort human labels for skill discovery roots. These are only LABELS: the
 * picker builds its rows from the roots the host actually reported (see
 * `readCatalog`), so an id missing here still shows up, just with its raw id.
 * Never treated as the authoritative vocabulary — that is the registry's.
 */
export const SKILL_SOURCES = {
  'project-dsh': '本项目 .dsh/skills',
  'project-agents': '本项目 .agents/skills',
  'user-dsh': '全局 ~/.dsh/skills',
  'user-agents': '全局 ~/.agents/skills',
  'agent-agents': '会话 agent 目录',
  'agent-workbuddy': 'WorkBuddy agent 目录',
  custom: '配置指定的自定义目录',
  bundled: '插件自带的技能',
};

/** Label one discovery root, falling back to the raw id. */
export function sourceLabel(id) {
  return SKILL_SOURCES[id] ?? id;
}
