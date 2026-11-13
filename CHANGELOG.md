# Changelog

## 2.4.5

发布整理（无行为变更）：

- 脚本里不再硬编码本机 `app.asar` 路径，改为参数或 `DSH_APP_ASAR`；缺失时自动 SKIP 并说明原因。
- README 收敛成项目门面，设计取舍与实测取证移到 `docs/DESIGN-NOTES.md`。
- 补 `.gitignore`（运行时产物 `audit.jsonl` / `provenance-cache.json` 不入库）与 `package.json` 的 `license` 字段。

## 2.4.4

与 Skills Manager 兼容。

- **技能影子的 seam 换掉了。** 旧实现用 `skills.register()`，产生 rank 250 的 runtime 条目；Skills Manager 在**同一个 agent 层**注册自己的 provider，项目级技能 rank 99–249。同层按 rank 先到先得，所以**旧影子对项目级技能从来没赢过**——遮蔽静默失效，且日志全程无异常。现在是每 agent 一个 rank-0 provider，同层稳赢；改规则变成改活集合 + `invalidate()`，不再逐名注册。
- **只遮蔽全局已启用的技能。** 启用状态读宿主 registry 的 `invocation` 标志（Skills Manager 的全局开关就编码在那里），不去读它的状态文件、不运行它的代码。规则指向当前停用的技能时保留待命，那边一启用、下一个 step 自动屏蔽。
- **面板清单同步收窄**：停用的技能不再进勾选清单；已配置但停用的行保留、勾选、标注「已在全局停用」；被屏蔽的技能用封名快照重建，不让插件自己的名字冒充本机来源。
- **`list()` 过滤非 kebab 名**：registry 的 `validateCandidate` 在 provider try/catch 之外抛错，一个非法名会毒化所有消费者的 `skills.list()`。
- 新增回归锁：selftest 9b–9g（启用门、rank 冲突、转换路径、一次注册、非法名、清单过滤）、12b（provider 释放）、e2e 2 项（停用保留行、脚注门控）。

## 2.4.3

- **resume 的会话曾经永远不再被掩码**：`agent/disposed` 把 id 永久放进 `settled`，恢复后同 id 的新 fiber 在 `pre-step` 直接短路，技能影子（只在 pre-step 建立）永远缺失。现在 `agent/created` 先清掉该 id 的旧判定。
- **读取在途 ≠ 只读**：设置客户端快照的 `loading` 期就带占位的 `writable:false`，旧面板把占位当政策。现在只有 `ready + writable:false` 判只读，其余显示「正在读取」且清单保持可用。
- `mutate()` 抛异常不再让面板永久卡在「保存中…」。
- 被拒绝的保存会真的重读并把草稿落回宿主事实（原来的提示语在说谎）。
- `agent/disposed` 补上 `liveAgents` 剪枝（注释一直承诺，代码漏了）。
- 403 拒绝改为机器码，由面板按页面语言映射文案；测试不再污染生产 `audit.jsonl`。

## 2.4.2

- **`webServer` 竞态**：它由别的插件提供，本插件激活时可能还不存在。旧代码读一次、读不到就永久放弃，面板 fetch 到没人注册的路径、拿到纯文本 404，用户看到裸解析错误。现在走 `ctx.inject` 延迟激活，注册失败也只记审计，绝不拖垮掩码。
- 客户端识别 404 并给出「接口没有注册，重启应用可恢复」的专门文案。

## 2.4.1

UI 与交互审计：注入样式表补 `:hover`/`:focus-visible`/`:disabled`；说明文字退出视觉中心；字号过 craft 下限；触摸目标与键盘可达性；长包名不挤计数；清单空态有说明；「重新读取清单」按钮在健康状态下也存在；归属扫描在飞时继续轮询。

## 2.4.0

工具按「谁注册了它」分节，归属由静态扫描包代码得出（worker 线程 + 磁盘缓存 + 按 key 退避）；按名字前缀猜分类的旧规则删除。

## 2.3.x

配置面从 JSON 编辑改为勾选清单；修复面板滚不动、默认展开的节点不动、旧宿主缺 `stored` 时整表覆盖三个问题。

## 2.1.0

设置页热更：`loader/volatile-update` 重建规则图并唤醒所有在管 agent，双向 diff 即时生效，无需重启或新会话。

## 2.0.0

按 preset 的规则图（`presets` + `*` 通配 + 基线三态）与自带客户端半边。

## 1.x

单 preset + 一份 deny 名单的初版。
