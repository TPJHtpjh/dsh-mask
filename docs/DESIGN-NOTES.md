# 设计笔记与实测取证

这份文件记录**为什么实现长成这样**。每条结论都来自源码阅读或本机实测，不是推测；被推翻的方案也留着——重复踩坑的代价比写下来高。

## 一、两条遮蔽机制的选择

### 工具：逐名 `restrict()`

`ctx.tools.restrict({deny:[name]})` 本身就是探针：干净返回 = 已掩，抛错 = 这里没有可掩的（未知名、scope-local 名、保留传输名）。

三条实测事实决定了写法：

1. **必须逐名**。批量 `restrict()` 是全有或全无，一个不可掩的名字会让整批被拒，结果所有请求的工具都还看得见。
2. **`schemas(scope)` 会撒谎**（实测报 35，而该 agent 自己的视图有 73）。所以它只能当**名字提示**用于前缀展开：漏掉的名字下一轮补，编出来的名字被 `restrict()` 自己拒掉。**没有任何判据来自 `schemas`**。
3. **早轮次跑在全部注册完成之前**，未注册名会抛。所以每次施加都包在 guard 里，失败记审计后忽略——掩码是优化，不是闸门，任何情况下都不能让会话创建或本轮 turn 失败。

### 技能：同名不可调用的影子

一开始考虑在 `agent/pre-step` 改写 `<available_skills>` 消息。**源码否决了这条路**：`dsh-tool-skill` 每步用全量快照算 digest 并重写覆盖消息，改写必然每轮抖动。影子才是被支持的 seam——目录（消费者按 `modelInvocable` 过滤）和加载（判 not invocable）同时消失，digest 稳定。

## 二、rank：影子为什么必须是 provider 而不是 `skills.register()`

v2.4.4 的核心发现，全部来自源码：

- 宿主 `@deepseek-ai/dsh-skill` 的 `SkillRegistry` 分层合并：最近层的条目**同名直接胜出**；**同一层内**候选按 `rank` 升序排序，第一个赢（`compareIndexedCandidates`），后来的同名条目被跳过并打一条 warn。
- `skills.register()` 产生的是 runtime 条目，rank 固定 **250**（`RUNTIME_RANK`）。
- Skills Manager 的 `registerAgentSkillProviders` 对**每个 agent** 调 `agent.ctx.skills.registerProvider()`，注册在**同一个 agent 层**；它的候选 rank 是项目根 99–249、`user-dsh` 399、`agents` 450。

结论：**旧影子对项目级技能从来没赢过**。rank 250 输给 rank 199，名字归对方，遮蔽静默失效——而日志和审计全程无异常，因为它「成功」了。

现在的做法：每 agent 一个 rank **0** 的影子 provider，`list()` 对每个已封名字回非调用行。rank 0 稳赢同层一切。附带好处：改规则 = 改活集合 + `invalidate()`，不再逐名注册，也就没有第二个名字的「provider already registered」冲突。

这条被 selftest 9c 钉住——假注册表复刻了真实的 rank 合并语义，把影子 rank 改回 250 立刻红。

## 三、provider 的 `list()` 必须过滤非 kebab 名

registry 的 `validateCandidate` 对非法技能名**抛错，而且发生在 provider 的 try/catch 之外**。后果不是「我们这一轮失败」，是**所有消费者**的 `skills.list()` 被毒化——技能系统整个坏掉。

一个手写的 `denyNames: ['My_Skill']` 就能触发。非法名永远不可能撞上真技能，所以直接不播报。selftest 9g 锁住。

## 四、启用状态从哪读

Skills Manager 的全局开关编码在它上报给 registry 的 `invocation` 标志里（停用 ⇒ 两个 flag 都 false）。本插件只读这个字段：

- **不去读它的 `state.json`**（那是它的私产，格式会变）；
- **不运行它的代码**（依赖另一个插件的内部函数 = 绑死版本）；
- provider 元数据是**宿主契约**，`invocation` 是 registry 的公开字段。

判定是 **not-false**，不是 is-true：没有 `invocation` 对象的技能（没装 Skills Manager 的机器上的 bundled 技能）默认视为启用，保持可屏蔽。所以这套逻辑在无 Skills Manager 的环境里零回归。

## 五、影子行不能冒充清单

影子赢了名字之后，agent 视图里那个技能就变成我们的行了——`provider: cherry-toolfilter`、非调用。如果直接把它端给面板，会出现两个错误读数：

1. 被屏蔽的技能从勾选清单里**消失**（用户以为规则没生效）；
2. 或者显示成「已在全局停用」（把我们的屏蔽说成 Skills Manager 的停用）。

修法：清单遇到自家影子行时，用**封名时存下的 `provider/source/description` 快照**重建那一行。快照同时是 unseal diff 的匹配依据——不重新发现，否则每步都会「解除影子→重新看见→再影子」抖动。

## 六、时序（都是实测出来的）

1. `agent/created` 时注册表只有一半工具（`automation_*`、`plugin_manager` 等在 created 返回之后才注册）→ 需要 `pre-step` 补刀，最多 3 轮。
2. **`webServer` 竞态**（v2.4.2）：它由别的插件提供，本插件激活时可能还不存在。旧代码在 `apply()` 里读一次、读不到就永久放弃 → 面板 fetch 一个没人注册的路径 → 服务器回通用纯文本 404 `not found` → `response.json()` 把解析器抱怨原样端给用户，清单全空且「重新读取」永远无效。现在读不到就走 `ctx.inject(['webServer'], …)`（cordis 的延迟激活：服务出现那一刻回调，effect 归子 fiber，无轮询无定时器），且 `register()` 抛错被吞掉记审计——面板起不来绝不拖垮掩码。
3. **resume 的会话曾经永远不再被掩码**（v2.4.3）：`agent/disposed` 把 id 永久放进 `settled`，resume 后同 id 的新 fiber 在 `pre-step` 直接短路。技能影子只在 pre-step 建立，所以恢复的会话技能影子永远缺失。现在 `agent/created` 先清掉该 id 的全部旧判定（那些 verdict 属于已死的 fiber）。
4. **设置客户端快照的词汇表是读出来的**（v2.4.3）：真实状态是 `loading | idle | ready`，且 **loading 期就带占位的 `writable:false` 和 `revision:undefined`**。把占位当政策会在读取还在路上时宣称「本部署只读」——一个等一次 round-trip 自愈的状态被说成权限问题。现在 `loading/idle/无 revision` 只是「正在读取」，清单保持可用（勾选状态来自 catalog 的 `stored`，本来就已可用），只有保存按钮等待；`ready + writable:false` 才是真只读。同理 `mutate()` 抛异常（不只返回 false）必须包住，否则绕过 `setBusy(false)`，面板永久卡在「保存中…」。
5. **技能发现只在 `pre-step` 做**：`agent/created` 是 await 的，不把文件扫描塞进会话创建。从不发消息的会话不显示目录，在那里影子是纯成本。

## 七、面板的四条硬语义

`rules.js` / `index.js` / `client.js` 必须同读一处，任何一侧重写都会漂移：

1. **面板只渲染宿主下发的 `catalog.stored`，绝不自己重算规则。** 客户端 realm 导不进 `buildRules`/`toRulesConfig`；在浏览器里重写折叠逻辑必然和宿主漂移。`stored` 就是宿主驱动掩码用的那个对象，所以「勾上 = 实际生效」是**构造保证**，不是约定。
2. **没读到清单就不给编辑。** 清单缺失、或宿主进程太旧没下发 `stored` 时，整个清单区不渲染、保存禁用并说明原因——那时任何勾选框都在说谎，而按空草稿保存会把在用的规则整表冲掉。
3. **写了空数组 = 说过了。** `tools.deny: []` 是明确表态（什么都不掩）；缺这个键才叫「没谈过工具」（继续套基线）。这是「全不选」能活下来的前提。
4. **`*` 不抄进各模式。** 在别的模式视图里 `*` 掩掉的名字显示为勾选且禁用并标注来源；复制进每个模式会让 `*` 变成摆设——日后在 `*` 里撤规则会失效而框框看着还是对的。

保存语义两条实测复现过的闭环断裂：省略 `defaults` 会让基线下次读回时偷偷折进来（面板显示未勾、实际全掩）；留着 v1 `presetId`/`deny` 则每次读都再合并回去，**取消勾选等于没取消**。`roundtrip-proof.mjs` 各有一条锁住。

## 八、工具归属：为什么必须扫，为什么不能猜

宿主注册表**不存归属**：`dsh-tools` 只做 `layer.tools.insert(name, definition)`，definition 只有 `{name, description, parameters, output, timeoutMs}`。想按「谁注册了它」分组，只能从包代码反推。

- **按名字前缀分类被实测推翻两次**：前缀漏掉 `edit`/`write`/`job_*`/`create_goal` 等一大截名字；而 `ops_*`、`subagent`、`workflow` 是**运行时用变量名注册**的，任何静态扫描都拿不到，只能老实落在「来源未识别」。
- **更宽的规则（「注册文件里拼写了这个名字就算它注册的」）被实测否决**：手验 fixture 上 0 对 1 错，而字面规则 14/14 全对。**错归比不归更糟。**
- 扫描 ~1.9s（数千文件），所以：绝不在宿主主线程扫（会卡住所有会话），走 worker 线程；catalog 不等它，有缓存就报，没有就先全归「来源未识别」并明说「正在识别」。
- 缓存 key = 分桶方案版本 + profile 路径 + 所扫 archive + 已安装包集合。少了后两项，一次无 archive 的 CLI/测试扫描就能冒充 Electron 宿主的答案——**实测发生过**。

## 九、作用域安全

- 一切 scope-writing 都经 `agent.ctx` 的服务。从插件自身 context 注册会落**全局层**、波及所有模式。
- 实测：`agent.ctx.skills` **属性访问会抛** `cannot get property "skills" without inject`（当模块没声明 inject 时），而 `agent.ctx.get('skills')` 返回绑定该 agent 的服务。所以 `scopedService()` = 属性 → `agent.ctx.get()` → `agentPresets.serviceFor()` 兜底。
- `tools/change` / `skills/change` 触发复查，两类事件分开记账：pass 内**自触发**（我们的 `restrict()` 会同步发事件）合并为每 pass 一次欠账；pass 间**外部**事件走 1 秒 leading-edge 限流，一个 burst 只买一次复查（每 agent 上限 16 次）。否则一轮几十个名字的自触发会吃光预算，真正的晚注册事件反而没命可用。
- `agent-preset/selected`（会话中途切 preset）清掉旧 settle 判定。
- `agent/disposed` 全量清理，包括 `liveAgents` 的强引用剪枝（注释一直承诺、代码曾经漏了，于是死 agent 会被 catalog 继续调 `schemas()` 直到 LRU 淘汰）。

## 十、UI 与交互

- **`:hover` / `:focus-visible` / `:disabled` 在 React 内联 style 里表达不了**——这不是「忘了写样式」，是结构性的。所以有一张按 id 注入一次的样式表；灰阶 over 继承色，跟主题走；transition 100ms，带 `prefers-reduced-motion` 关闭。
- **说明性文字不许占视觉中心**。原来标题下面直接堆两段说明，首次打开时真正的清单被推到折叠线以下。现在头部只留**状态**（读取失败/只读/保存结果，都带 `role`），瞬态提示下沉到清单里贴着它们描述的内容，常驻说明变成清单末尾脚注。
- **滚动契约**：外壳给面板的是定高列并裁掉溢出，所以根元素必须自己管滚动（`height:100%` + `overflow:hidden`，内层 body `flex:1 1 auto` + `minHeight:0` + `overflowY:auto`）。写成自适应高度的 div，内容一长就顶出视口、滚不动。
- **折叠状态只能有一个来源**。`expanded = force || defaultOpen || open` 让 header 的 `setOpen(!expanded)` 恒为 false，凡默认展开的节永远点不动。
- 字号下限 11px；触摸目标 ≥24px（WCAG 2.5.8）；折叠头 `role=button` + `tabIndex=0` + `aria-expanded` + Enter/Space；模式 chip 带 `aria-pressed`；搜索框补 `aria-label`（placeholder 单独不算标签）。
- 长包名不许挤掉计数：标题 `ellipsis + minWidth:0`，计数与箭头 `flexShrink:0`。
- 空态要有说明：本机没读到任何工具时列表原本什么都不渲染，看着像坏了。

## 十一、配置面为什么必须自带客户端半边

宿主 API 不等于 UI。`settings.describe()` 会把带 volatile 字段的 entry 服务成一个 namespace，但**出厂 Web UI 没有任何通用表单渲染器**——Plugins 页只提供槽位，你能看到的每一个设置页都是某个官方插件手写的伴生客户端包占位实现的。全 asar + 全 profile 扫描确认 `plugins.row.config` 零出厂占位者。所以想要一个能点的入口，插件必须自己送这个半边。

两个「配置面不可见」的独立根因，都是量出来的：

1. `Config` 根本没建起来——Electron 宿主进程里 `DSH_PROFILE_DIR` 为 `null`，file-URL 兜底因此从未执行。`link:` 包裸导入 `@deepseek-ai/schemastery` 会 `ERR_MODULE_NOT_FOUND`，所以要按候选目录解析：裸导入 → `$DSH_PROFILE_DIR` → `process.cwd()` → cwd 的三级父目录。**不要依赖 `DSH_PROFILE_DIR`**：Electron 里它是 null，而 `process.cwd()` 就是 profile 目录。
2. 首次加客户端声明必须**真重启宿主进程**。宿主的模块元数据缓存（含「不是客户端包」这个否定结论）按行名 + base URL 缓存到重启为止，且源码里没有全量重扫路径。补声明、重装、开新窗口、刷新页面全都命中旧缓存，浏览器连请求都不会发。判据：宿主进程启动时刻 vs `package.json` 里 `dsh.client` 的写入时刻。

**volatile 是表单门槛**：设置页只为能通过 `.volatile()` 标记触达的字段渲染表单；没有 volatile 字段的 entry 直接被跳过。

## 十二、测试脚手架自身的坑（都会造成假绿）

- **props 必须按生产形状给**。直接把 form service 当 `configForms` 传进去，渲染的是「未挂载」兜底页而断言照样全过。
- **假 React 的 setter 必须绑定调用时那一刻的槽位数组**，不能读模块全局：异步用例在 `await` 处交错，全局指向「最后渲染的那个用例」，实测把 `saving` 忙态漏进下一个用例，表现为「找不到保存按钮」这种莫名其妙。
- **`mutate` 的记录要每个用例独立**，否则并发异步用例互相覆盖写入断言。
- **假宿主必须实现真正的延迟 `ctx.inject`**（声明的服务不齐备就绝不回调）。假 inject 立即回调的话，竞态回归锁测的还是旧代码的运气。
- **`schemas(scope)` 要按 agent 分开**，共享 extras 会让跨 agent 隔离的断言因为错误的原因通过。
- **测试不许污染生产数据**。假宿主跑 `apply()` 曾每次往 `audit.jsonl` 写十行假记录，现在全部 `audit:false`。
- **归属 fixture 不能假设某个插件还装着**：以扫描结果为地面真值——该 owner 一个名字都没扫到 = 环境变化，跳过并打印；扫到了但归给别人 = 规则回归，失败。
- **变异测试**：每个修复都要「回退→对应检查必须红→恢复→绿」。绿灯本身不证明测试有牙齿。

## 十三、验证的层级

可信度从高到低：**活体实测 > 审计记录 > 探针读数 > 离线自测 > 口头断言**。

离线套件能钉住语义与回归，但它跑在假注册表上。涉及宿主真实行为的结论（rank 合并、`invocation` 字段、`validateCandidate` 的抛错位置）都取自源码阅读；要在活系统上确认，就在目标会话里问 `cordis_inspect_query(host, Tool, listTools)`，技能则看下一轮目录与 `skill` 调用结果。
