/**
 * Browser half of cherry-toolfilter: the masking panel.
 *
 * Why this file exists — the Host API is not a UI. `settings.describe()` serves
 * a namespace for every entry whose `Config` exports a volatile field, and
 * `ctx.configForms` mirrors it into the browser, but the shipped Web UI renders
 * NO generic form: measured, the client slot tree reports "none are taken yet"
 * for `plugins.row.config` across the entire shipped tree, and every settings
 * page you can actually see is a hand-written companion package occupying a
 * slot. So a plugin that wants a reachable configuration surface ships this half.
 *
 * What it shows: checkboxes over the REAL inventory, grouped by which package
 * registered each tool, never by categories invented from name prefixes and
 * never as raw JSON. The inventory comes from the Host's read-only route
 * `/api/cherry-toolfilter/catalog`.
 *
 * ONE IMPLEMENTATION OF THE RULES. This realm cannot import anything but
 * `react`, so it must not re-derive what a preset hides — a second copy of
 * `buildRules` here could drift from the host and the boxes would lie. The route
 * therefore serves `stored`: the host's own RESOLVED rule map, baseline folding,
 * legacy `presetId`+`deny` fields and the `*` merge already applied. The panel
 * renders exactly that and nothing else, which also means it cannot show a
 * "clean" draft that a save would silently change.
 *
 * Layout contract: the shell hands a panel a fixed-height column and clips
 * overflow, so the root owns its own scroll (`height:100%` + `overflowY:auto` on
 * an inner body) the way dsh-favorites does. An auto-height root grows past the
 * viewport and becomes unscrollable.
 *
 * Placement: a left-column entry. The shell renders an icon for every
 * `sidebar.panellist` registration and the matching page from the keyed `main`
 * slot (`key` = panel id) — the same pair the official schedule companion uses.
 *
 * Load contract (verified against `dsh-client-modules`): `package.json` declares
 * `exports["./client"]` and `dsh.client.platform`; this file registers a lazy
 * factory with `window.__ModuleLoader__`; the factory returns a cordis plugin
 * `{ inject, apply }`. Package metadata including a NEGATIVE "not a client
 * package" verdict is cached per Loader specifier until the Host process
 * restarts, so the very first time this declaration is added a genuine app
 * restart is required — a reload, a reinstall or a new window will not do it.
 *
 * Saving goes through the ConfigForm controller of namespace `cherry-toolfilter`
 * (`ctx.configForms.get(ns)`): `mutate(ops, revision)` applies
 * `{op:'set'|'unset', path, value}` atomically. The Host turns a volatile-field
 * write into an in-place cell swap plus `loader/volatile-update`, so a saved edit
 * reaches every live session on its next step without a restart.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cherry-toolfilter',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** The settings namespace: the profile patch row id. */
    const NS = 'cherry-toolfilter';
    /** This bundle's package name. */
    const BUNDLE = '@local/dsh-cherry-toolfilter';
    /** Left-column panel id, shared by the icon and the `main` page. */
    const PANEL_ID = 'cherry-toolfilter';
    /** Locale namespace for this panel's own copy. */
    const LOCALE = 'cherry-toolfilter';
    /** The Host's read-only inventory route. */
    const API = '/api/cherry-toolfilter/catalog';
    /** The pseudo-mode that widens every other configured mode (lib/rules.js). */
    const WILDCARD = '*';
    /** The mode the built-in baseline applies to; mirrors lib/rules.js. */
    const DEFAULT_PRESET = 'cherry';
    /** How often the panel re-reads the catalog while a scan is in flight. */
    const SCAN_POLL_MS = 2500;
    /** How many times it will ask, so a failing scan cannot poll forever. */
    const SCAN_POLL_LIMIT = 12;
    /** Id of the panel's injected stylesheet, so it is added exactly once. */
    const STYLE_ID = 'cherry-toolfilter-styles';
    /** Whether the stylesheet landed in this document; stops repeat attempts. */
    let stylesDone = false;

    const zh = {
      panel: '屏蔽工具',
      title: '屏蔽工具与技能',
      intro: '勾上 = 这个模式的提示词里没有它；取消勾选 = 马上恢复。保存后受影响的会话在下一个 step 生效，不用重启、不用新建会话。',
      whichMode: '模式',
      groupTools: '工具',
      modeHint: '只有这里列出的模式会被改；没列出的模式完全不动，成本和不装这个插件一样。',
      modeAll: '所有模式',
      modeFresh: '（该模式当前不受影响；勾任何一项才会纳入屏蔽）',
      groupSkills: '技能',
      groupSources: '按技能来源整批屏蔽',
      groupProviders: '按技能注册方整批屏蔽',
      search: '搜索名称…',
      searchAria: '按名称过滤清单',
      selectAll: '全选',
      selectNone: '全不选',
      countHidden: '已屏蔽 {n}',
      countTotal: '共 {n}',
      loading: '正在读取本机工具与技能清单…',
      loadFailed: '读不到清单：{msg}',
      retry: '重新读取',
      reload: '重新读取清单',
      notReady: '清单读到之前不能保存：那时勾选状态必然失真，保存会静默改动看不见的规则。',
      staleHost: '宿主进程还在跑旧版本，清单里没有「已解析规则」这一项。此时无法判断哪些规则正在生效，保存已被禁用——完整重启一次应用即可恢复编辑。',
      scanning: '首次识别工具来源需要几秒，识别不到的都列在「来源未识别」里。',
      mcpEmpty: '当前没有注册中的 MCP 服务。',
      toolsEmpty: '本机没有读到任何工具。清单读不到时上面的提示会说明原因。',
      skillsEmpty: '当前没有发现任何技能。技能按项目/全局目录发现，打开对应项目后会变多。',
      liveTitle: '本次加载已屏蔽的会话',
      liveRow: '{n} 个工具已屏蔽',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。受影响的会话在下一个 step 生效。',
      rejected: '这份配置没有被接受，已重新读取当前值。',
      readOnly: '本部署的设置为只读，无法保存。',
      formPending: '正在读取本插件的当前配置…（清单已经可用，可先勾选；配置读到后保存才会开启。）',
      noForms: '设置客户端未挂载，无法保存配置。',
      noFetch: '这个页面读不到本机清单接口，无法勾选，保存也已禁用。',
      noRoute: '本机清单接口没有注册：屏蔽插件的宿主半边没有在运行，或还是不带这个接口的旧版本。完整重启一次应用即可恢复；点「重新读取」只是重试，宿主没起来时不会有变化。',
      notLocal: '清单接口拒绝了这个页面的读取（只有本机应用页面可以读它）。如果这是从应用里打开的面板，请确认地址是本机的 http://127.0.0.1。',
      unavailable: '该条目当前没有可配置的 schema。通常是 Host 进程启动时 package.json 还没带上 client 声明 —— 完整重启一次应用即可。',
      dirty: '有未保存的改动',
      notFound: '本机未注册',
      skillOff: '已在全局停用',
      skillsNote: '全局已停用的技能不在这里列出，勾这里只作用于当前启用的技能；带「已在全局停用」标记的行是规则保留项，那边一启用就自动屏蔽。',
      orphanGroup: '已配置、但本机当前没有这个工具（规则保留，注册后即屏蔽）',
      fromWildcard: '由「所有模式」屏蔽，需在那里取消',
      wildcardNote: '这里勾上的东西对每一个已配置的模式都生效；要单独调某个模式，点上面的模式名切过去。',
      bucketBuiltin: '应用自带',
      bucketOfficial: '官方插件',
      bucketThirdparty: '第三方插件',
      bucketLocal: '本地自研插件',
      bucketMcp: 'MCP 服务',
      bucketUnknown: '来源未识别',
      prefixGroup: '前缀规则（屏蔽所有以此开头的工具名）',
    };

    const en = {
      panel: 'Tool masking',
      title: 'Mask tools & skills',
      intro: 'Checked = this mode’s prompt never sees it. Unchecking restores it. Saved rules reach affected live sessions on their next step — no restart, no new session.',
      whichMode: 'Mode',
      groupTools: 'Tools',
      modeHint: 'Only the modes listed here are changed. Anything not listed stays exactly as it would be without this bundle.',
      modeAll: 'Every mode',
      modeFresh: '(this mode is currently unaffected; ticking anything opts it into masking)',
      groupSkills: 'Skills',
      groupSources: 'Hide whole skill sources',
      groupProviders: 'Hide whole skill providers',
      search: 'Search names…',
      searchAria: 'Filter the list by name',
      selectAll: 'All',
      selectNone: 'None',
      countHidden: '{n} hidden',
      countTotal: '{n} total',
      loading: 'Reading this machine’s tool & skill inventory…',
      loadFailed: 'Inventory unreadable: {msg}',
      retry: 'Read again',
      reload: 'Re-read inventory',
      notReady: 'Saving is disabled until the inventory is read: the checkboxes would necessarily be wrong and a save would silently change rules you cannot see.',
      staleHost: 'The Host process is still running an older build, so its catalog carries no resolved-rule map. The panel cannot tell which rules are in force, saving is disabled, and a full app restart restores editing.',
      scanning: 'Identifying tool owners takes a few seconds the first time; anything unrecognised is listed under “owner unknown”.',
      mcpEmpty: 'No MCP server is currently registered.',
      toolsEmpty: 'No tool was read from this machine. If the inventory cannot be read, the notice above says why.',
      skillsEmpty: 'No skill was discovered yet. Skills come from project/global directories, so this fills up once you open that project.',
      liveTitle: 'Sessions masked by this load',
      liveRow: '{n} tool(s) masked',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. Affected sessions apply this on their next step.',
      rejected: 'The deployment rejected this write; the stored value was re-read.',
      readOnly: 'This deployment stores settings read-only.',
      formPending: 'Reading this plugin’s current settings… the list is already usable and your ticks are kept; saving turns on once the read finishes.',
      noForms: 'The settings client is not mounted, so nothing can be saved.',
      noFetch: 'This page cannot reach the local inventory route, so nothing can be checked and saving is disabled.',
      noRoute: 'The inventory route is not registered on this machine: the host half of the masking plugin is not running, or is a build without the route. A full app restart restores it — “read again” only retries, which changes nothing while the host half is absent.',
      notLocal: 'The inventory route refused this page (only a same-machine app page may read it). If this panel is opened from the app itself, make sure the address is a local http://127.0.0.1 one.',
      unavailable: 'This entry has no configurable schema yet — usually the Host process started before package.json gained the client declaration. Fully restart the app once.',
      dirty: 'Unsaved changes',
      notFound: 'not registered here',
      skillOff: 'globally disabled',
      skillsNote: 'Skills switched off in the Skills Manager are not listed here — ticking only ever applies to currently-enabled skills. A row tagged “globally disabled” is a kept rule: dormant now, masking the moment it is enabled there.',
      orphanGroup: 'Configured but not registered on this machine (kept; it masks once it appears)',
      fromWildcard: 'hidden by “every mode” — untick it there',
      wildcardNote: 'Anything checked here hides from every configured mode. To tune one mode alone, click its name above.',
      bucketBuiltin: 'Shipped with the app',
      bucketOfficial: 'Official plugins',
      bucketThirdparty: 'Third-party plugins',
      bucketLocal: 'Local plugins',
      bucketMcp: 'MCP servers',
      bucketUnknown: 'Owner unknown',
      prefixGroup: 'Prefix rules (masks every tool name starting with this)',
    };

    /**
     * Host bucket id -> this panel's dictionary key. Anything absent falls back
     * to the label the host itself served, so a new host bucket still reads.
     */
    const BUCKET_KEYS = {
      builtin: 'bucketBuiltin',
      official: 'bucketOfficial',
      thirdparty: 'bucketThirdparty',
      local: 'bucketLocal',
      mcp: 'bucketMcp',
      unknown: 'bucketUnknown',
    };

    const S = {
      // The shell clips this column, so the panel owns its scroll: a fixed header
      // plus a body that scrolls, never an auto-height root.
      root: {
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      head: {
        flexShrink: 0,
        padding: '14px 22px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        borderBottom: '1px solid rgba(127,127,127,0.2)',
      },
      body: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '4px 22px 48px',
      },
      h1: { fontSize: '16px', fontWeight: 650, margin: 0, letterSpacing: '0' },
      // Section headings must be unmistakably headings — at 12.5px they read as
      // body text and the panel loses its outline.
      h2: { fontSize: '14px', fontWeight: 600, margin: '22px 0 6px', letterSpacing: '0.01em' },
      // 0.72 opacity over an unknown background is a guess at contrast; keeping
      // secondary copy at ~0.8 of the inherited token stays above the AA floor.
      muted: { opacity: 0.8, fontSize: '12.5px', lineHeight: 1.55, margin: 0 },
      note: { opacity: 0.72, fontSize: '12.5px', lineHeight: 1.55, margin: '2px 0 0', maxWidth: '680px' },
      modeRow: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
      chip: {
        padding: '4px 11px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.3)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      chipOn: {
        padding: '4px 11px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.6)',
        background: 'rgba(127,127,127,0.26)',
        color: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      input: {
        // 13px reads as input, not label; 12px sat under every neighbour text.
        fontSize: '13px',
        padding: '6px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.08)',
        color: 'inherit',
        width: '200px',
        boxSizing: 'border-box',
      },
      button: {
        padding: '5px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.12)',
        color: 'inherit',
        fontSize: '12.5px',
        minHeight: '28px',
        cursor: 'pointer',
      },
      buttonPrimary: {
        padding: '5px 18px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.5)',
        background: 'rgba(127,127,127,0.28)',
        color: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        minHeight: '30px',
        cursor: 'pointer',
      },
      groupHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '8px 6px',
        margin: '0 -6px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: 600,
        borderTop: '1px solid rgba(127,127,127,0.16)',
        userSelect: 'none',
      },
      groupBody: { display: 'flex', flexDirection: 'column', padding: '2px 0 6px 4px' },
      bulkRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '2px 0 4px' },
      item: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '7px',
        padding: '4px 0',
        fontSize: '13px',
        lineHeight: 1.45,
      },
      itemName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', flexShrink: 0, fontSize: '12.5px' },
      itemNote: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // 10px fell under the 11px small-text floor; tags are still quiet, just legible.
      tag: { fontSize: '11px', opacity: 0.6, flexShrink: 0 },
      checkbox: { margin: 0, flexShrink: 0, alignSelf: 'center' },
      badge: { fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(127,127,127,0.16)' },
      foot: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '20px' },
      icon: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' },
    };

    /**
     * One stylesheet for the panel, injected once per document.
     *
     * Inline React styles cannot express `:hover`, `:focus-visible` or
     * `:disabled` — without this, every button, chip and row in the panel gave
     * the user zero feedback that anything was clickable or keyboard-reachable,
     * which is the "鼠标放上去没有聚焦显示" complaint. Colours stay on the
     * inherited-token approach the inline styles already use (grays over
     * whatever background the shell supplies) so the panel follows the theme.
     *
     * One `stylesDone` flag guards the whole job because a headless renderer has
     * no document at all and must not be retried on every render; and the style
     * element itself is id-guarded, so a remount of this half never duplicates it.
     * @param {Document} doc - the document to attach to.
     * @returns {boolean} whether the document is now styled.
     */
    function injectStyles(doc) {
      if (stylesDone) return true
      if (doc === undefined || doc === null) return false
      if (doc.getElementById(STYLE_ID) !== null) {
        stylesDone = true
        return true
      }
      const tag = doc.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = [
        // Hover feedback is a frequent trigger: keep it under 100ms per craft's
        // motion thresholds, and never animate a state change into nothing.
        '.ct-row, .ct-clickable, .ct-head { transition: background-color 100ms ease; }',
        // Interactive elements: hover + focus must be visible, and only when the
        // element can actually act (a disabled save stays quiet).
        `.ct-row:hover:not(:has(input:disabled)) { background: rgba(127,127,127,0.10); }`,
        `.ct-row { border-radius: 6px; padding-left: 6px; padding-right: 6px; margin-left: -6px; margin-right: -6px; min-height: 24px; }`,
        // Craft's WCAG 2.5.8 floor is 24px; the row label already carries the hit
        // area, and the checkbox itself sits inside a 24px line box.
        `.ct-clickable:enabled:hover { background: rgba(127,127,127,0.22); }`,
        `.ct-clickable:enabled:focus-visible, .ct-input:focus-visible { outline: 2px solid rgba(127,127,127,0.65); outline-offset: 1px; }`,
        `.ct-clickable:disabled { cursor: default; opacity: 0.45; }`,
        `.ct-head:hover { background: rgba(127,127,127,0.08); }`,
        `.ct-head:focus-visible { outline: 2px solid rgba(127,127,127,0.65); outline-offset: -2px; }`,
        `.ct-input::placeholder { opacity: 0.6; }`,
        // Respect the system's motion preference on the one transition used.
        '@media (prefers-reduced-motion: reduce) { .ct-row, .ct-clickable, .ct-head { transition: none; } }',
      ].join('\n')
      doc.head.appendChild(tag)
      stylesDone = true
      return true
    }

    /** Fill `{name}` placeholders without pulling in a locale runtime. */
    const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_all, key) => String(values?.[key] ?? ''));

    /** Stable empty shape for one mode's draft selection. */
    function emptyPick() {
      return { tools: [], prefixes: [], skills: [], providers: [], sources: [] };
    }

    /** Whether a pick hides nothing at all. */
    function emptySelection(pick) {
      return pick.tools.length + pick.prefixes.length + pick.skills.length
        + pick.providers.length + pick.sources.length === 0;
    }

    /**
     * The draft read from the host's RESOLVED rule map (`catalog.stored`).
     *
     * No folding happens here on purpose: the host already folded the built-in
     * baseline, the legacy `presetId`+`deny` fields and the `*` merge, so what
     * this returns is by construction what masking is doing right now. A mode the
     * host does not list simply has no rules yet, and gets an empty pick.
     * @param {object} stored - preset id -> resolved rule block.
     * @returns {Record<string, object>} mode id -> pick.
     */
    function draftFrom(stored) {
      const out = {};
      const source = stored !== null && typeof stored === 'object' ? stored : {};
      for (const [id, block] of Object.entries(source)) {
        out[id] = {
          tools: [...(block?.tools?.deny ?? [])].sort(),
          prefixes: [...(block?.tools?.denyPrefix ?? [])].sort(),
          skills: [...(block?.skills?.denyNames ?? [])].sort(),
          providers: [...(block?.skills?.denyProviders ?? [])].sort(),
          sources: [...(block?.skills?.denySources ?? [])].sort(),
        };
      }
      return out;
    }

    /**
     * The value the draft turns back into.
     *
     * Three things this has to get right, each one a closure break if it does
     * not (all three were reproduced against the real rule engine):
     *
     * 1. `defaults` is written as an explicit FALSE, never merely unset. The
     *    baseline folds into cherry whenever `defaults` is unset or true, so
     *    unsetting it lets 25 tools the boxes did not show come back on the next
     *    read. Writing false makes the stored lists the whole truth.
     * 2. The legacy v1 fields (`presetId`, `deny`) are UNSET. They live in the
     *    same row and `toRulesConfig` MERGES them into `presets` on every read, so
     *    leaving them behind means unticking a legacy rule does nothing at all —
     *    the host re-adds it. The host's `stored` map already contains the merged
     *    result, so the explicit lists carry those rules forward once the fields
     *    are gone.
     * 3. Every list is written even when empty, because presence is what says
     *    "somebody decided about tools": a cherry block with no `tools.deny` array
     *    is treated as never having addressed tools. An emptied selection must keep
     *    the key with an empty array or "uncheck everything" silently re-hides the
     *    baseline.
     *
     * A mode whose pick is empty and which the host did NOT report as configured is
     * not written at all: merely clicking a mode chip to look at it, or ticking and
     * unticking again, must not opt that mode into masking (and into the `*`
     * wildcard) behind the user's back. The host reports cherry whenever the
     * baseline is in force, so the ordinary "uncheck everything in cherry" case IS
     * known and does get written — as an explicit empty list, which is exactly the
     * authored statement that stops the fold.
     * @param {Record<string, object>} draft - mode id -> pick.
     * @param {string[]} listed - modes the host reported as having rules.
     * @returns {Array<object>} mutate ops.
     */
    function opsFromDraft(draft, listed = []) {
      const known = new Set(listed);
      const presets = {};
      for (const [id, pick] of Object.entries(draft)) {
        if (emptySelection(pick) && !known.has(id)) continue;
        presets[id] = {
          tools: { deny: [...pick.tools].sort(), denyPrefix: [...pick.prefixes].sort() },
          skills: {
            denyNames: [...pick.skills].sort(),
            denyProviders: [...pick.providers].sort(),
            denySources: [...pick.sources].sort(),
          },
        };
      }
      return [
        { op: 'set', path: ['defaults'], value: false },
        { op: 'unset', path: ['presetId'] },
        { op: 'unset', path: ['deny'] },
        Object.keys(presets).length === 0
          ? { op: 'unset', path: ['presets'] }
          : { op: 'set', path: ['presets'], value: presets },
      ];
    }

    /** Toggle one name inside one list of one mode's pick. */
    function toggle(pick, list, name, on) {
      const has = pick[list].includes(name);
      if (on === has) return pick;
      const next = on ? [...pick[list], name] : pick[list].filter((entry) => entry !== name);
      return { ...pick, [list]: next.sort() };
    }

    /** Add every name of a list that is not already picked. */
    function addMany(pick, list, names) {
      const extra = names.filter((name) => !pick[list].includes(name));
      if (extra.length === 0) return pick;
      return { ...pick, [list]: [...pick[list], ...extra].sort() };
    }

    /** Drop every name of a list that is currently picked. */
    function removeMany(pick, list, names) {
      const doomed = new Set(names);
      return { ...pick, [list]: pick[list].filter((name) => !doomed.has(name)) };
    }

    /** The left-column panel icon: a funnel with a hard stop line. */
    function CherryIcon() {
      return React.createElement(
        'span',
        { style: S.icon, title: zh.panel },
        React.createElement(
          'svg',
          { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
          React.createElement('path', { d: 'M3 5h18' }),
          React.createElement('path', { d: 'M6 5v3a6 6 0 0 0 12 0v-3' }),
          React.createElement('path', { d: 'M12 14v6' }),
          React.createElement('path', { d: 'M9 20h6' }),
        ),
      );
    }

    /**
     * One checkbox row.
     * @param {object} props - name, note, tag, checked, locked, onChange.
     * @returns {object} a React element.
     */
    function CheckRow(props) {
      return React.createElement(
        'label',
        {
          className: 'ct-row',
          style: { ...S.item, cursor: props.locked ? 'default' : 'pointer' },
          title: props.locked ? (props.tag ?? props.note ?? props.name) : (props.note ?? props.name),
        },
        React.createElement('input', {
          type: 'checkbox',
          style: S.checkbox,
          checked: props.checked === true,
          // A row `*` is hiding cannot be unticked from another mode: unticking it
          // here would look like a fix and change nothing.
          disabled: props.disabled === true || props.locked === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        React.createElement('span', { style: S.itemName }, props.name),
        props.tag ? React.createElement('span', { style: S.tag }, props.tag) : null,
        props.note ? React.createElement('span', { style: S.itemNote }, props.note) : null,
      );
    }

    /**
     * A collapsible block of checkboxes with all/none shortcuts.
     *
     * The open state is one piece of React state and nothing else. An earlier
     * version ORed a `defaultOpen` prop into the expanded flag, so the header's
     * click handler computed `!expanded` (always false) and any block that opened
     * by default could never be collapsed — the reported "clicking does nothing".
     * @param {object} props - title, rows, handlers, localised labels.
     * @returns {object} a React element.
     */
    function Section(props) {
      const [open, setOpen] = React.useState(props.defaultOpen === true);
      const t = props.t;
      // A search forces every block open for its duration; a click flips the
      // user's own choice.
      const expanded = props.force === true || open;
      const rows = props.rows;
      const hiddenCount = rows.filter((row) => row.checked === true).length;
      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          {
            className: 'ct-head',
            style: S.groupHead,
            // A div with a click handler is unreachable by keyboard and announces
            // nothing; the platform shell's own panels expose a real disclosure.
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded,
            onClick: () => setOpen((value) => !value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setOpen((value) => !value)
              }
            },
          },
          React.createElement('span', { style: { width: '10px', flexShrink: 0 } }, expanded ? '▾' : '▸'),
          // Owner names like `@deepseek-ai/dsh-experimental-tool-agent-team` must
          // not push the counts off a narrow panel: the title truncates, the counts
          // never do.
          React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
          props.subtitle ? React.createElement('span', { style: { ...S.tag, flexShrink: 0 } }, props.subtitle) : null,
          hiddenCount > 0 ? React.createElement('span', { style: { ...S.badge, flexShrink: 0 } }, fill(t('countHidden'), { n: hiddenCount })) : null,
          React.createElement('span', { style: { ...S.muted, flexShrink: 0 } }, fill(t('countTotal'), { n: rows.length })),
        ),
        expanded
          ? React.createElement(
            'div',
            { style: S.bulkRow },
            React.createElement('button', { type: 'button', className: 'ct-clickable', style: S.button, disabled: props.disabled, onClick: () => props.onBulk(true) }, t('selectAll')),
            React.createElement('button', { type: 'button', className: 'ct-clickable', style: S.button, disabled: props.disabled, onClick: () => props.onBulk(false) }, t('selectNone')),
            rows.length === 0 && props.emptyText ? React.createElement('span', { style: S.muted }, props.emptyText) : null,
          )
          : null,
        expanded
          ? React.createElement('div', { style: S.groupBody }, rows.map((row) => React.createElement(CheckRow, {
            key: row.name,
            name: row.name,
            note: row.note,
            tag: row.tag,
            checked: row.checked,
            locked: row.locked,
            disabled: props.disabled,
            onChange: (on) => props.onToggle(row.store ?? row.name, on),
          })))
          : null,
      );
    }

    /**
     * Render the masking panel.
     * @param {object} props - `configForms` (the browser plugin context, read
     *   lazily), `t` (this panel's translate) and `catalog` (the Host route,
     *   injected by a test harness or fetched by this half).
     * @returns {object} a React element.
     */
    function CherryPanel(props) {
      // Attach the hover/focus stylesheet on the first render pass that can. A
      // headless render (a test harness, a server pass) has no document and simply
      // leaves the flag unset, so the next real render still tries.
      if (stylesDone === false) injectStyles(typeof document === 'undefined' ? undefined : document)
      // Read the services at render time: they can activate after this half
      // mounts, and a panel opened later has to see them.
      const formsCtx = props.configForms;
      const forms = typeof formsCtx?.get === 'function' ? formsCtx.get('configForms') : formsCtx;
      const t = typeof props.t === 'function' ? props.t : (key) => zh[key] ?? en[key] ?? key;
      const controller = forms !== undefined && typeof forms.get === 'function' ? forms.get(NS) : undefined;
      const state = controller === undefined ? undefined : controller.getSnapshot();

      const [catalog, setCatalog] = React.useState(props.catalog ?? null);
      const [catalogError, setCatalogError] = React.useState(null);
      // `props.catalog === undefined` means nobody injected a catalog, so this
      // half owns the fetch; an injected one (the test harness) never needs it.
      const [loading, setLoading] = React.useState(props.catalog === undefined);

      /** The host's resolved rules as checkboxes; empty until the route answers. */
      const storedDraft = () => draftFrom(catalog?.stored);

      const [draft, setDraft] = React.useState(() => storedDraft());
      const [mode, setMode] = React.useState(() => {
        const keys = Object.keys(storedDraft());
        // Open on cherry, not on `*`: the wildcard is a cross-mode setting, and a
        // panel that lands there first invites editing everything when the user
        // meant one mode.
        if (keys.includes(DEFAULT_PRESET)) return DEFAULT_PRESET;
        return keys.length > 0 ? keys[0] : DEFAULT_PRESET;
      });
      const [filter, setFilter] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [, setTick] = React.useState(0);
      /** Whether the user has edited the draft since it was last synced. */
      const touched = React.useRef(false);

      // Re-render when the Host accepts a write or the stored value changes.
      React.useEffect(() => {
        if (controller === undefined || typeof controller.subscribe !== 'function') return undefined;
        return controller.subscribe(() => setTick((value) => value + 1));
      }, [controller]);

      // Re-sync the draft whenever the host's resolved rules move — after a save,
      // after a settings edit elsewhere, or when the inventory first arrives — but
      // never over a draft the user has already edited, or a slow route would eat
      // their ticks. `storedKey` is what makes this fire on a real change only.
      const storedKey = JSON.stringify(catalog?.stored ?? null);
      React.useEffect(() => {
        if (touched.current) return;
        setDraft(draftFrom(catalog?.stored));
        setMessage(null);
      }, [storedKey]);

      const load = React.useCallback(async () => {
        if (typeof fetch !== 'function') {
          setCatalogError('nofetch');
          setLoading(false);
          return;
        }
        setLoading(true);
        setCatalogError(null);
        try {
          const response = await fetch(API, { headers: { 'x-cherry-toolfilter': '1' } });
          // Read as text first and parse by hand. `response.json()` on the
          // server's generic plain-text 404 `not found` produced the cryptic
          // `Unexpected token 'o', "not found" is not valid JSON` — true but
          // useless: the real cause is that NOBODY registered the route (the
          // host half is not running, or is too old to have it), which a
          // restart fixes and re-reading does not.
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            if (response.status === 404) throw new Error('noroute');
            throw new Error(`HTTP ${response.status} ${text.slice(0, 80)}`);
          }
          if (body?.ok !== true) {
            // The host answers a refusal with a machine code, never prose: the
            // host does not know the page's language, so the panel maps the
            // code to its own dictionary here.
            if (body?.code === 'not-local') throw new Error('notlocal');
            throw new Error(body?.error ?? `HTTP ${response.status}`);
          }
          setCatalog(body);
        } catch (error) {
          setCatalogError(error instanceof Error ? error.message : String(error));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        if (props.catalog === undefined) load();
      }, [load, props.catalog]);

      /**
       * The Host runs the provenance scan in a worker thread and never blocks the
       * catalog on it, so an early open legitimately reports `scanning` with no
       * result yet and every tool lands under "owner unknown". Poll a bounded
       * number of times so the sections re-group themselves once the scan lands
       * instead of leaving the user stuck on a wrong-looking list; a scan that
       * keeps failing simply stops being polled (the Host also backs off).
       *
       * The condition is `scanning` alone — NOT `scanning && scannedAt === 0`.
       * Installing a bundle starts a NEW scan while the previous result is still
       * served, so `scannedAt` is a non-zero old timestamp and the narrower test
       * never fired: the ownership groups stayed frozen at the pre-install
       * answer until the user reloaded by hand.
       */
      const pendingScan = catalog !== null && catalog?.provenance?.scanning === true;
      const [scanPolls, setScanPolls] = React.useState(0);
      React.useEffect(() => {
        if (props.catalog !== undefined) return undefined;
        if (pendingScan === false || scanPolls >= SCAN_POLL_LIMIT) return undefined;
        const timer = setTimeout(() => {
          setScanPolls((count) => count + 1)
          load()
        }, SCAN_POLL_MS)
        return () => clearTimeout(timer)
      }, [pendingScan, scanPolls, load, props.catalog]);

      if (forms === undefined) {
        return React.createElement(
          'div',
          { style: S.root },
          React.createElement(
            'div',
            { style: S.head },
            React.createElement('h1', { style: S.h1 }, t('title')),
            React.createElement('p', { style: S.muted }, t('noForms')),
          ),
        );
      }

      if (state === undefined || state.status === 'unavailable') {
        return React.createElement(
          'div',
          { style: S.root },
          React.createElement(
            'div',
            { style: S.head },
            React.createElement('h1', { style: S.h1 }, t('title')),
            React.createElement('p', { style: S.muted }, t('unavailable')),
            React.createElement('p', { style: S.muted }, `${NS} · ${BUNDLE}`),
          ),
        );
      }

      /**
       * The settings client's own snapshot vocabulary, read out of
       * `dsh-client-ui-settings` rather than guessed: `loading` (the describe
       * round-trip is in flight), `idle` (no view yet), `ready`. The early
       * states ship a PLACEHOLDER `writable: false` and no revision — so
       * treating them as "this deployment is read-only" tells the user a lie
       * (nothing about their permissions changed; waiting fixes it), and
       * disabling the picker would be doubly wrong: the checkboxes come from
       * the catalog's `stored`, which is already available. Only a `ready`
       * snapshot's `writable: false` is the deployment's real policy.
       */
      const formPending = state.status === 'loading' || state.status === 'idle' || state.revision === undefined;
      const readOnlyDeployment = state.status === 'ready' && state.writable === false;

      const editable = readOnlyDeployment === false;
      const pick = draft[mode] ?? emptyPick();
      const setPick = (next) => {
        touched.current = true;
        setDraft({ ...draft, [mode]: next });
      };
      const query = filter.trim().toLowerCase();
      /**
       * Does this row match the search box?
       *
       * The search has to look at BOTH the name shown and the key the rule is
       * stored under, or the same rule becomes findable under one spelling and
       * invisible under the other: an MCP row shows `github` but stores
       * `mcp__github__`, and a raw prefix shows `automation_*` but stores
       * `automation_`. Searching only the display name meant typing the rule's
       * own key found nothing.
       * @param {string} display - the text shown on the row.
       * @param {string} [key] - the stored key, when it differs.
       * @returns {boolean}
       */
      const matches = (display, key) => {
        if (query === '') return true;
        const haystack = [display, key ?? display].map((value) => String(value).toLowerCase());
        return haystack.some((value) => value.includes(query));
      };
      const searching = query !== '';

      /* ── inventory ────────────────────────────────────────────────────── */
      const tools = catalog?.tools ?? [];
      const listed = new Set(tools.map((entry) => entry.name));
      const skills = catalog?.skills ?? [];
      const sources = catalog?.skillSources ?? [];
      const mcpServers = catalog?.mcpServers ?? [];

      // `*` is read from the DRAFT so a tick made in the `*` view shows up in every
      // other view at once, before any save.
      const wideDraft = draft[WILDCARD] ?? emptyPick();
      // While editing `*` itself its rows are ordinary boxes; in any other mode
      // they render checked-and-locked.
      const wide = mode === WILDCARD ? undefined : wideDraft;
      const extra = (list) => (wide === undefined ? [] : wide[list]);

      /**
       * The checked/locked/tag state of one row.
       * @param {string} list - which of the five lists the rule lives in.
       * @param {string} name - what the row shows and what onToggle gets back.
       * @param {string} [tag] - secondary text (source, prefix form, …).
       * @param {string} [key] - the name to look up when it differs from what the
       *   row displays (MCP rows show the server, store `mcp__<server>__`).
       * @returns {object} a row descriptor for Section.
       */
      const box = (list, name, tag, key) => {
        const probe = key ?? name;
        const own = pick[list].includes(probe);
        const fromWide = wide !== undefined && wide[list].includes(probe);
        const mark = fromWide && !own ? t('fromWildcard') : '';
        return {
          name,
          store: probe,
          checked: own || fromWide,
          locked: !own && fromWide,
          tag: mark === '' ? (tag ?? '') : (tag ? `${tag} · ${mark}` : mark),
        };
      };

      /**
       * The names a bulk action may legitimately write for THIS mode.
       *
       * Rows hidden only by `*` render checked-and-locked, and a single click on a
       * locked box does nothing — but a bulk "select all" that walked the same rows
       * would copy those names into this mode's own list. That is invisible today
       * (they are already hidden) and wrong tomorrow: remove the rule from `*` later
       * and this mode keeps hiding names the user never picked here. So bulk actions
       * see exactly the rows the boxes claim they can edit.
       * @param {string} list - which pick list the names belong to.
       * @param {string[]} names - candidate names.
       * @returns {string[]} the names owned by this mode.
       */
      const ownable = (list, names) => (wide === undefined
        ? names
        : names.filter((name) => !(wide[list].includes(name) && !pick[list].includes(name))));

      /* ── tool sections: one per owning package ────────────────────────── */
      // Bucket ORDER and identity come from the host's `ownerGroups`, so the two
      // halves cannot drift apart when a bucket is added. The host's own label is
      // the fallback; this panel's dictionary only overrides the ids it knows.
      const hostGroups = catalog?.ownerGroups ?? [];
      const bucketOrder = hostGroups.map((entry) => entry.id);
      const bucketTitles = {};
      for (const entry of hostGroups) {
        const key = BUCKET_KEYS[entry.id];
        bucketTitles[entry.id] = key === undefined ? entry.label : t(key);
      }
      const byOwner = new Map();
      for (const entry of tools) {
        if (!matches(entry.name)) continue;
        const key = `${entry.group}\u0000${entry.owner}`;
        if (!byOwner.has(key)) byOwner.set(key, { group: entry.group, owner: entry.owner, rows: [] });
        byOwner.get(key).rows.push(entry);
      }
      const toolSections = [...byOwner.values()].sort((a, b) => {
        const byBucket = bucketOrder.indexOf(a.group) - bucketOrder.indexOf(b.group);
        return byBucket !== 0 ? byBucket : String(a.owner).localeCompare(String(b.owner));
      });
      // A configured name the enumeration missed stays listed and checked, so a
      // reporting gap can never silently un-mask a rule.
      const orphans = [...new Set([...pick.tools, ...extra('tools')])].filter((name) => !listed.has(name) && matches(name));

      // Only TRUE MCP prefixes belong to the MCP section. A hand-authored
      // `denyPrefix: ['automation_']` is a raw prefix: the engine matches it with
      // `startsWith`, so it must render as itself, checked from `pick.prefixes`
      // directly. Feeding every prefix through the MCP row builder made such a
      // rule display UNCHECKED (its store key became `mcp__automation___`, which
      // never equals the stored `automation_`) — an active hide shown as off,
      // unticklable, and silently dropped on save.
      const isMcpPrefix = (prefix) => /^mcp__[^_].*__$/.test(prefix);
      const mcpPrefixes = [...new Set([...pick.prefixes, ...extra('prefixes')])].filter(isMcpPrefix);
      const rawPrefixes = [...new Set([...pick.prefixes, ...extra('prefixes')])]
        .filter((prefix) => !isMcpPrefix(prefix));
      const mcpRows = [...new Set([
        ...mcpServers,
        ...mcpPrefixes.map((prefix) => prefix.replace(/^mcp__/, '').replace(/__$/, '')),
      ])].filter((name) => name !== '' && matches(name, `mcp__${name}__`)).sort();

      const listedSkills = new Set(skills.map((entry) => entry.name));
      // A row the host marks `enabled: false` is switched off in SkillsManager
      // right now. The host only ever serves such a row when a rule already
      // names it (the picker otherwise lists enabled skills only), so it must
      // render checked AND say why it is dormant — otherwise it looks like an
      // active hide that does nothing.
      const skillRows = [
        ...skills.filter((entry) => matches(entry.name))
          .map((entry) => (entry.enabled === false ? { ...entry, disabledHere: true } : entry)),
        ...[...new Set([...pick.skills, ...extra('skills')])]
          .filter((name) => !listedSkills.has(name) && matches(name))
          .map((name) => ({ name, description: '', source: t('notFound') })),
      ];
      const sourceRows = [...new Set([
        ...sources.map((entry) => entry.id),
        ...skills.map((entry) => entry.source).filter(Boolean),
        ...pick.sources,
        ...extra('sources'),
      ])].filter(matches).sort();
      const providerRows = [...new Set([
        ...skills.map((entry) => entry.provider).filter(Boolean),
        ...pick.providers,
        ...extra('providers'),
      ])].filter(matches).sort();

      /* ── mode chips ───────────────────────────────────────────────────── */
      const modeIds = [...new Set([DEFAULT_PRESET, ...(catalog?.presets ?? []), ...Object.keys(draft)])];

      /** Whether this half owns the inventory (nobody injected one). */
      const ownsCatalog = props.catalog === undefined;

      const save = async () => {
        if (controller === undefined) return;
        setBusy(true);
        setMessage(null);
        // `mutate()` may REJECT (a settings service that throws), not just
        // return false. Without the guard the throw escapes before `setBusy
        // (false)` and the panel freezes on "saving…" forever with no way to
        // retry — the one state a settings UI must never enter.
        let ok = false;
        try {
          ok = await controller.mutate(opsFromDraft(draft, Object.keys(catalog?.stored ?? {})), state.revision) === true;
        } catch {
          ok = false;
        }
        if (ok) {
          // The host has just re-derived its rules from this write (baseline
          // folding, the `*` merge), so the catalog's `stored` is stale. When this
          // half owns the route, re-read it; the boxes then re-sync from the
          // host's own answer. A caller that injected a catalog (a test) is asked
          // to re-render with the host-recomputed one.
          touched.current = false;
          if (ownsCatalog) await load();
        } else {
          // The notice promises the stored value was re-read, so it has to be.
          // Re-syncing is NOT automatic here: the write was refused, so the
          // host's `stored` is byte-identical to the pre-save one, the
          // `storedKey` effect does not fire, and the boxes would keep the
          // ticks the deployment just rejected — and re-send them on the next
          // save. Drop the draft to the host's truth first, then re-read the
          // catalog so the inventory is fresh too (a revision conflict usually
          // means somebody else changed the settings).
          touched.current = false;
          setDraft(draftFrom(catalog?.stored));
          if (ownsCatalog) await load();
        }
        setBusy(false);
        setMessage(ok ? t('saved') : t('rejected'));
      };

      /**
       * Compare the draft against what the host currently reports AS DISPLAYED.
       * Neither side re-derives anything, so an un-edited draft is exactly clean.
       */
      const dirty = catalog !== null && JSON.stringify(draft) !== JSON.stringify(storedDraft());

      /**
       * Nothing may be edited before the inventory arrived: the boxes would lie.
       *
       * `stored` is required as well as the inventory. A Host process still running
       * an older build serves a catalog without it, and this half derives its whole
       * draft from that map — with it missing the draft starts EMPTY, so ticking one
       * box and saving would write a config containing only that one name and
       * silently delete every rule that was in force. Refusing to edit is the only
       * safe reading of a catalog this half cannot interpret.
       */
      const ready = catalog !== null && catalog?.stored !== undefined && catalog?.stored !== null;
      const staleHost = catalog !== null && (catalog.stored === undefined || catalog.stored === null)
      const canSave = editable && ready && formPending === false && !busy && dirty;
      const live = Object.entries(catalog?.sealedBy ?? {});
      /**
       * Every picker block goes through here. When the host gave no resolved
       * rules there is no honest way to draw a checkbox at all — an unchecked box
       * would read as "this tool is visible", which is precisely the claim we
       * cannot verify — so nothing renders and only the notice above stands.
       */
      const section = (sectionProps) => (ready === false
        ? null
        : React.createElement(Section, {
          t,
          disabled: !editable || busy,
          force: searching,
          ...sectionProps,
        }));

      return React.createElement(
        'div',
        { style: S.root },
        React.createElement(
          'div',
          { style: S.head },
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('h1', { style: S.h1 }, t('title')),
            React.createElement('span', { style: { flex: '1 1 12px' } }),
            dirty ? React.createElement('span', { style: S.badge }, t('dirty')) : null,
            React.createElement('button', {
              type: 'button',
              className: 'ct-clickable',
              style: S.buttonPrimary,
              disabled: !canSave,
              onClick: save,
            }, busy ? t('saving') : t('save')),
          ),
          React.createElement(
            'div',
            { style: S.modeRow },
            React.createElement('span', { style: { ...S.muted, fontWeight: 600 } }, t('whichMode')),
            modeIds.map((id) => React.createElement('button', {
              key: id,
              type: 'button',
              className: 'ct-clickable',
              style: id === mode ? S.chipOn : S.chip,
              'aria-pressed': id === mode,
              onClick: () => setMode(id),
            }, id)),
            draft[WILDCARD] === undefined
              ? React.createElement('button', {
                key: WILDCARD,
                type: 'button',
                className: 'ct-clickable',
                style: mode === WILDCARD ? S.chipOn : S.chip,
                'aria-pressed': mode === WILDCARD,
                onClick: () => {
                  touched.current = true;
                  setDraft({ ...draft, [WILDCARD]: emptyPick() });
                  setMode(WILDCARD);
                },
              }, t('modeAll'))
              : null,
            React.createElement('input', {
              className: 'ct-input',
              style: S.input,
              placeholder: t('search'),
              'aria-label': t('searchAria'),
              value: filter,
              onChange: (event) => setFilter(event.target.value),
            }),
            // The inventory is a snapshot of THIS machine: an MCP server that
            // connects later, or a plugin installed after the panel opened, only
            // shows up after a re-read. The button used to appear only on an
            // error, so the documented "read again" step did not exist in the
            // healthy case at all.
            ownsCatalog
              ? React.createElement('button', {
                type: 'button',
                className: 'ct-clickable',
                style: S.button,
                disabled: loading || busy,
                onClick: load,
              }, t('reload'))
              : null,
          ),
          // Everything left here is a STATE, not an explanation: loading, a failed
          // read, a refused edit, a save result. The always-on prose (what a tick
          // means, which modes are touched) used to stack under the title, where it
          // was the loudest thing on screen while being the least actionable; it now
          // sits as a footnote at the bottom of the list, still on screen whenever
          // the user scrolls to it.
          // Two different reasons for refusing to edit, and only one of them is
          // fixed by restarting: an unread catalog clears itself on retry, while a
          // Host process too old to serve `stored` will stay that way until relaunch.
          staleHost === true
            ? React.createElement('p', { style: S.muted, role: 'status' }, t('staleHost'))
            : ready === false && loading === false && catalogError === null
              ? React.createElement('p', { style: S.muted, role: 'status' }, t('notReady'))
              : null,
          catalogError !== null
            ? React.createElement(
              'div',
              { style: S.modeRow, role: 'alert' },
              React.createElement('span', { style: S.muted }, catalogError === 'nofetch'
                ? t('noFetch')
                : catalogError === 'noroute'
                  // The route itself is absent — a different fix than a retry,
                  // so it gets its own sentence instead of a raw parse error.
                  ? t('noRoute')
                  : catalogError === 'notlocal'
                    // The host's refusal code, mapped to THIS page's language:
                    // the host never sends prose because it does not know it.
                    ? t('notLocal')
                    : fill(t('loadFailed'), { msg: catalogError })),
              React.createElement('button', { type: 'button', className: 'ct-clickable', style: S.button, onClick: load }, t('retry')),
            )
            : null,
          editable ? null : React.createElement('p', { style: S.muted, role: 'status' }, t('readOnly')),
          // The wait is its own notice: the list works, only saving is not yet
          // open, and the sentence must say exactly that.
          formPending === true ? React.createElement('p', { style: S.muted, role: 'status' }, t('formPending')) : null,
          message === null ? null : React.createElement('p', { style: S.muted, role: 'status' }, message),
        ),

        React.createElement(
          'div',
          { style: S.body },
          React.createElement('h2', { style: S.h2 }, t('groupTools')),
          // The empty state matters: a list that silently renders nothing reads as
          // a broken panel, not as "nothing to mask here".
          toolSections.length === 0 && orphans.length === 0 && mcpRows.length === 0 && rawPrefixes.length === 0
            ? React.createElement('p', { style: { ...S.muted, padding: '4px 0' } }, t('toolsEmpty'))
            : null,
          toolSections.map((group) => section({
            key: `${group.group}/${group.owner}`,
            title: group.owner === '' ? bucketTitles[group.group] : group.owner,
            subtitle: group.owner === '' ? '' : bucketTitles[group.group],
            defaultOpen: group.rows.some((entry) => pick.tools.includes(entry.name)),
            rows: group.rows.map((entry) => ({ ...box('tools', entry.name), note: entry.description })),
            onToggle: (name, on) => setPick(toggle(pick, 'tools', name, on)),
            onBulk: (on) => {
              const names = ownable('tools', group.rows.map((entry) => entry.name));
              setPick(on ? addMany(pick, 'tools', names) : removeMany(pick, 'tools', names));
            },
          })),
          orphans.length > 0 ? section({
            key: '__orphan',
            title: t('orphanGroup'),
            defaultOpen: true,
            rows: orphans.map((name) => ({ ...box('tools', name, t('notFound')), checked: true })),
            onToggle: (name, on) => setPick(toggle(pick, 'tools', name, on)),
            onBulk: (on) => setPick(on
              ? addMany(pick, 'tools', ownable('tools', orphans))
              : removeMany(pick, 'tools', ownable('tools', orphans))),
          }) : null,

          mcpRows.length > 0 ? section({
            key: '__mcp',
            title: t('bucketMcp'),
            subtitle: 'mcp__<server>__*',
            defaultOpen: mcpPrefixes.length > 0,
            emptyText: t('mcpEmpty'),
            rows: mcpRows.map((server) => box('prefixes', server, `mcp__${server}__*`, `mcp__${server}__`)),
            onToggle: (prefix, on) => setPick(toggle(pick, 'prefixes', prefix, on)),
            onBulk: (on) => {
              const prefixes = ownable('prefixes', mcpRows.map((server) => `mcp__${server}__`));
              setPick(on ? addMany(pick, 'prefixes', prefixes) : removeMany(pick, 'prefixes', prefixes));
            },
          }) : null,

          // Raw prefixes authored in YAML (`denyPrefix: ['automation_']`). The
          // engine matches them with startsWith, so the row IS the prefix: shown
          // with its own store key, tickable, removable, and carried untouched
          // through a save.
          rawPrefixes.filter((prefix) => matches(`${prefix}*`, prefix)).length > 0 ? section({
            key: '__prefixes',
            title: t('prefixGroup'),
            defaultOpen: true,
            rows: rawPrefixes.filter((prefix) => matches(`${prefix}*`, prefix)).map((prefix) => box('prefixes', `${prefix}*`, '', prefix)),
            onToggle: (prefix, on) => setPick(toggle(pick, 'prefixes', prefix, on)),
            onBulk: (on) => {
              const prefixes = ownable('prefixes', rawPrefixes.filter((prefix) => matches(`${prefix}*`, prefix)))
              setPick(on ? addMany(pick, 'prefixes', prefixes) : removeMany(pick, 'prefixes', prefixes))
            },
          }) : null,

          React.createElement('h2', { style: S.h2 }, t('groupSkills')),
          skillRows.length > 0 || pick.skills.length > 0 ? section({
            key: '__skills',
            title: t('groupSkills'),
            defaultOpen: pick.skills.length > 0,
            emptyText: t('skillsEmpty'),
            rows: skillRows.map((entry) => {
              const row = box('skills', entry.name, entry.source);
              if (entry.disabledHere === true) {
                row.tag = row.tag === '' ? t('skillOff') : `${row.tag} · ${t('skillOff')}`;
              }
              return { ...row, note: entry.description };
            }),
            onToggle: (name, on) => setPick(toggle(pick, 'skills', name, on)),
            onBulk: (on) => setPick(on
              ? addMany(pick, 'skills', ownable('skills', skillRows.map((entry) => entry.name)))
              : removeMany(pick, 'skills', ownable('skills', skillRows.map((entry) => entry.name)))),
          }) : React.createElement('p', { style: S.muted }, t('skillsEmpty')),
          // Only when the host actually serves the enabled-state field: an older
          // Host lists everything it discovered and never filtered, so the
          // sentence would describe a filter that is not running.
          skills.length > 0 && skills.some((entry) => entry.enabled !== undefined)
            ? React.createElement('p', { style: { ...S.note, padding: '2px 0 6px' } }, t('skillsNote'))
            : null,
          sourceRows.length > 0 ? section({
            key: '__sources',
            title: t('groupSources'),
            defaultOpen: pick.sources.length > 0,
            rows: sourceRows.map((id) => box('sources', id, (sources.find((entry) => entry.id === id) ?? {}).label ?? '')),
            onToggle: (id, on) => setPick(toggle(pick, 'sources', id, on)),
            onBulk: (on) => setPick(on
              ? addMany(pick, 'sources', ownable('sources', sourceRows))
              : removeMany(pick, 'sources', ownable('sources', sourceRows))),
          }) : null,
          providerRows.length > 0 ? section({
            key: '__providers',
            title: t('groupProviders'),
            defaultOpen: pick.providers.length > 0,
            rows: providerRows.map((id) => box('providers', id)),
            onToggle: (id, on) => setPick(toggle(pick, 'providers', id, on)),
            onBulk: (on) => setPick(on
              ? addMany(pick, 'providers', ownable('providers', providerRows))
              : removeMany(pick, 'providers', ownable('providers', providerRows))),
          }) : null,

          // Transient states live INSIDE the list they describe: first open, an
          // in-flight source scan, a fresh mode. A permanent explanatory banner in
          // the header pushed the actual content below the fold and made every open
          // look like an error.
          loading ? React.createElement('p', { style: { ...S.muted, padding: '8px 0' }, role: 'status' }, t('loading')) : null,
          catalog?.provenance?.scanning === true
            ? React.createElement('p', { style: { ...S.muted, padding: '4px 0' }, role: 'status' }, t('scanning'))
            : null,
          draft[mode] === undefined && ready
            ? React.createElement('p', { style: { ...S.muted, padding: '4px 0' } }, t('modeFresh'))
            : null,
          mode === WILDCARD && ready
            ? React.createElement('p', { style: { ...S.muted, padding: '4px 0' } }, t('wildcardNote'))
            : null,
          // The live mask record only earns attention when there is one; the old
          // always-visible "no records yet" paragraph was the loudest thing under
          // the list on every single open.
          live.length > 0
            ? React.createElement(
              'div',
              null,
              React.createElement('h2', { style: S.h2 }, t('liveTitle')),
              React.createElement('div', { style: S.groupBody }, live.map(([agentId, names]) => React.createElement(
                'div',
                { key: agentId, style: S.item },
                React.createElement('span', { style: S.itemName }, agentId.slice(0, 18)),
                React.createElement('span', { style: S.itemNote }, fill(t('liveRow'), { n: names.length })),
              ))),
            )
            : null,
          // The explanation that used to be a headline block: kept, but as a
          // footnote — read it once, ignore it forever after.
          React.createElement(
            'div',
            { style: { borderTop: '1px solid rgba(127,127,127,0.16)', marginTop: '26px', paddingTop: '10px' } },
            React.createElement('p', { style: S.note }, t('intro')),
            React.createElement('p', { style: S.note }, t('modeHint')),
          ),
        ),
      );
    }

    /** Client services this half needs. */
    const inject = ['slots', 'locale'];

    /**
     * Mount the left-column panel: one `sidebar.panellist` icon plus the keyed
     * `main` page the shell opens for it.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      // Attach the hover/focus stylesheet at MOUNT time, so it is in place before
      // the panel's first paint rather than after its first render. The render-time
      // call stays as a fallback for a document that only exists later.
      injectStyles(typeof document === 'undefined' ? undefined : document)
      ctx.effect(() => ctx.locale.register(LOCALE, { zh, en }), 'cherry-toolfilter: dictionaries');
      const t = ctx.locale.bind(LOCALE);
      const slots = ctx.get('slots');
      if (slots === undefined) {
        console.error('[cherry-toolfilter] no client slots service; panel not mounted');
        return;
      }

      // The page, keyed by panel id: this is what the shell renders in the
      // central column when the icon is selected. `configForms` is read at
      // render time, not at mount, because the settings client can activate
      // after this half does.
      ctx.effect(() => slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE,
        inject: () => ({ configForms: ctx, t }),
      }, CherryPanel)), 'cherry-toolfilter: main panel');

      // The left-column icon that opens the page.
      ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        locale: LOCALE,
        label: () => t('panel'),
      }, CherryIcon)), 'cherry-toolfilter: sidebar entry');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
