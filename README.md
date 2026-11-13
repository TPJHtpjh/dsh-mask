# dsh-mask（cherry-toolfilter）

按 **agent preset × 来源规则** 屏蔽 DeepSeek Harness 宿主面工具与技能的插件。

左侧栏一个勾选面板，勾上 = 这个模式的提示词里再也没有它；取消 = 立刻恢复。保存后受影响的**现有会话**在下一个 step 生效，不用重启、不用新建会话。

English: a per-preset tool & skill mask for DeepSeek Harness. One `restrict()` call per tool name, one rank-0 shadow provider per agent for skills — both scoped to a single session instead of the whole app, and both reversible live.

## 为什么需要它

一个 agent preset 只能**添加**行。别的 bundle 在宿主面注册的工具和技能，对每个会话都可见；在 PTC 模式下它们会被整份渲染进提示词——几十个用不上的工具定义就是实打实的上下文成本。preset 的 YAML 无法关掉它们，这个插件就是那个开关。

未配置任何规则的模式**完全不受影响**：不注册、不写日志、零开销，成本和不装这个插件一样。

## 安装

```bash
git clone https://github.com/TPJHtpjh/dsh-mask.git
```

然后在 DSH 的插件管理里指向这个目录（`link:` 包）：

```
plugin_manager install_bundle <本仓库的绝对路径>
```

**首次装完必须完整重启一次应用**，只刷新页面不够——宿主的客户端模块扫描对「这不是客户端包」的否定结论会缓存到重启为止。重启后左侧栏出现「屏蔽工具」图标。

## 配置

两个入口写的是同一份数据，面板是首选。

### ① 面板

按模式（preset）分别勾选。工具按**谁注册了它**分节，一节一个包，节内可整节全选/全不选；技能、技能来源、技能注册方各成一块。顶部可切模式、可加「所有模式」通配块、可按名称过滤。

### ② bundle patch 行

```yaml
- insert:
    - id: cherry-toolfilter
      name: '@local/dsh-cherry-toolfilter'
      config:
        presets:
          cherry:
            tools:
              deny: [terminal_open, automation_create]   # 精确名；空数组 = 明确不掩任何工具
              denyPrefix: ['mcp__github__']              # MCP 前缀（mcp__<server>__<raw> 命名契约）
            skills:
              denyNames: [some-skill]                     # 显式名；尚未注册也接受，日后同名即屏蔽
              denyProviders: [dsh-skills-manager-external]# 按注册方整批
              denySources: [bundled]                      # 按发现根整批；取值以 registry 实际上报为准
          '*':                                            # 通配：只加宽已显式配置的模式
            tools: { deny: [ralph] }
```

`defaults` 只用来覆盖「要不要叠加内置基线」：`true` 强制叠加，`false` 关掉，省略则看该 preset 有没有写自己的 `tools.deny`。面板保存时一律显式写 `defaults: false` 并清掉 v1 字段，所以「全不选」是真的全不选。

v1 老配置（`presetId` + `deny`）继续可用。

## 与 Skills Manager 的关系

两层开关，各管各的，数据只读一处：

- **Skills Manager 管全局**：技能在它那里启用/停用，状态通过宿主 registry 的 `invocation` 标志表达。
- **本插件管模式级**：只对**当前全局启用**的技能施加遮蔽。那边关掉的技能不会重复出现在这里的勾选清单——已经关掉的东西再给一个开关只会让人困惑。
- 如果你已经写过规则指向某个当时处于停用状态的技能，那一行会**保留并标注「已在全局停用」**：规则待命，一旦那边启用，下一个 step 自动屏蔽。撤掉这一行仍是正常编辑。

## 机制

| 目标 | 手段 | 为什么这样做 |
|---|---|---|
| 工具 | 逐名 `agent.ctx.tools.restrict({deny:[name]})` | `restrict()` 本身就是唯一可信的探针：不抛 = 已掩，抛 = 这里没有可掩的。`schemas()` / `get()` 实测都会报错状态，只当名字提示用 |
| 技能 | 每 agent **一个** rank-0 影子 provider（`skills.registerProvider()`），对每个已封名字回 `{invocation:{modelInvocable:false,userInvocable:false}}` | 技能注册表是「宿主层 + 每 scope 层」：最近层同名直接胜出，**同一层内按 rank 升序先到先得**。rank 0 稳赢同层任何注册者，包括 Skills Manager |

两条都只作用于目标 agent 自己的 scope，不碰全局层。撤销规则时从活集合里删名并 `invalidate()`，同会话即时恢复。

审计日志 `audit.jsonl`（写在包目录旁，可配 `audit: false` 关闭或指定路径）记录每次施加：`requested / masked / refused / shadowed / lifted`。

## 验证

离线可跑，不联网、不需要宿主进程：

```bash
node scripts/selftest.mjs         # 467 项：假注册表复刻真实分层与 rank 合并、路由 handler 端到端、resume 回归锁
node scripts/e2e-client.mjs       # 56 项：真加载客户端半边 + 真渲染 + 真勾选保存 + UI/可达性断言
node scripts/roundtrip-proof.mjs  # 闭环证明：面板显示的集合 == 引擎实际屏蔽的集合，逐 case
node scripts/host-audit.mjs       # 13 项：宿主半边异常面（会抛的服务、恶意配置形状、webServer 竞态）
node scripts/localecheck.mjs      # zh/en 词典对齐
node scripts/deadcheck.mjs        # 无死导入 / 无未被引用的导出
```

`accuracy-fixture.mjs`（归属扫描准确率）和 `probe-*.mjs` 需要本机存在 DSH 的 `app.asar`：传路径或设 `DSH_APP_ASAR`，否则自动 SKIP 并说明原因。

## 已知边界

- 屏蔽只对该 agent 生效；规则变更在受影响会话的**下一个 step** 双向生效。
- 清单是「本机此刻」的注册表快照。MCP 后连、新装插件之后，点「重新读取清单」才会出现在列表里；已配置但当前没注册的名字会单独成组并保持勾选，不会因为枚举缺口被静默取消。
- 运行时用变量名注册的工具（宿主与各插件的动态注册）静态扫不到，永远落在「来源未识别」——宁可未识别，不做猜测归属。
- 注册晚于最后一轮 pass 的前缀成员可能漏掩，由变更事件触发的复查兜底（每 agent 有上限，防止抖动无限重试）。
- `denySources` 匹配的是 provider 自己上报的根标签，自定义 provider 的命名由它决定。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。设计取舍与踩坑记录（全部有源码或实测支撑）见 [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。
