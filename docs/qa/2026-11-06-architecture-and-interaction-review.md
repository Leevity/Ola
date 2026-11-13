# Ola 功能架构与对话交互评审

日期：2026-11-06 · 分支 `main-ts` · HEAD `d86a0bb` · 版本 1.0.6
性质：**只读代码评审 + 交互链路还原**，未修改任何产品代码。
关联：`docs/qa/2026-11-06-full-penetration-test.md`（穿透测试与修复记录）、`docs/migrations/ts-runtime/`（迁移台账）。

---

## 0. 一句话结论

**功能覆盖不缺，缺的是「层与层之间的约束」。** 24 个 Provider 预设、63 个 IPC handler、40+ Main 工具、20+ DAO、12 个 surface 都在；但能力声明散落在 6 处、靠硬编码白名单对齐，闸门失败不是按能力降级而是整轮拒绝。对话「不自然」也不是视觉问题，而是**同一段发送链路上叠了三次状态清空、两次页面切换和三条确认弹窗**——系统内部状态领先于用户可见反馈。

---

## 1. 口径与范围

- 「真实可用」= Main handler 已注册 + UI 有挂载点 + 有自动化或穿透证据；仅有代码不算可用。
- 「代码级接通」= 调用链完整，但依赖外部账号/服务器，未做真实联调。
- 零引用组件清单基于「组件 basename 是否出现在其他 ts/tsx」的只读统计；导出名与文件名不同的引用方式可能产生假阴性，其中 5 个已单独复核。
- 本轮未启动应用、未使用模型密钥、未改动 `out/` 产物。

---

## 2. 完整功能架构还原

| 层             | 职责                                                               | 关键路径                                                                                          | 健康度                               |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| UI 与页面      | 12 个 `ActiveSurface`、7 个 lazy 页面、右侧 7 类面板、3 类独立窗口 | `components/layout/Layout.tsx:564-575,1119-1203`、`App.tsx:1020-1046`、`stores/ui-store.ts:56-68` | 主页面全可达；**30 个组件零挂载**    |
| 编排与提交     | 工具快照、系统提示、资格判定、事件投影                             | `lib/agent/chat-send-message.ts`、`session-runtime-router.ts`、`lib/ipc/ts-runtime-bridge.ts`     | 单一 TS 执行轨道，但**两套提交条件** |
| 迁移闸门       | 决定这次运行能不能发出去                                           | `lib/ipc/ts-runtime-agent-eligibility.ts:48-69`、`ts-runtime-text-eligibility.ts:16-253`          | **6 类 NOT_MIGRATED 整轮拒绝**       |
| 工具注册／执行 | 渲染层注册 + Main 侧 ToolExecutor                                  | `lib/tools/index.ts:32-72`、`main/runtime/desktop-runtime.ts:360-405`                             | **两套定义，靠名字白名单对齐**       |
| Provider       | 5 种 codec、transport、24 个预设                                   | `runtime/providers/*`、`stores/providers/*`                                                       | 健康；能力元数据不进 runtime         |
| 契约           | run / message / event DTO                                          | `shared/runtime/contracts.ts:84-113`、`model.ts:34-44`                                            | **只带纯文本与有界图片**             |
| 存储           | SQLite、会话/项目/工作区隔离、schema v1–v11                        | `runtime/storage/*`、`main/db/`（20+ DAO）                                                        | 最完整的一层                         |

**能力覆盖清单（按用户可见功能分组）**

| 分组         | 覆盖                                                                         | 实际状态                                                                   |
| ------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 会话与模式   | chat / clarify / execute 三模式、流式、工具卡片、审批、压缩、导出、置顶/删除 | 接通；模式切换在主页无可见控件                                             |
| 文件与 Shell | Read/Write/Edit/Glob/Grep/Bash，本地与 SSH                                   | 接通                                                                       |
| Agent 编排   | Task/子代理/Team、Plan、Goal、Memory、Cron、Notify                           | 接通；Cron 真实触发未验                                                    |
| 模型与账户   | 24 preset、服务商增删改测试、OAuth、模型绑定、用量统计                       | 接通                                                                       |
| 扩展         | 内置插件、声明式 HTTP 扩展、MCP（stdio/SSE/HTTP）、技能、SOUL                | HTTP 扩展与 MCP 接通；**JS 扩展被隔离**、**技能市场外联失败已降级**        |
| 渠道         | 飞书/钉钉/Discord/QQ/Telegram/企业微信/微信公众号/WhatsApp                   | 代码级接通，**8 家均未真实联调**；普通会话里还受 `channelContext` 闸门限制 |
| 独立页       | 任务、资源、技能、SOUL、同步、绘图、翻译、用量、宠物工作室                   | 全部可达                                                                   |
| 远端与桌面   | SSH 独立窗口、终端、桌面宠物、通知浮窗                                       | 接通；**无障碍桌面控制两套命名都不可达**                                   |
| 设置         | 5 分区 22 页、权限、凭据、桌面自动化、项目智能                               | 全部可达，无白屏                                                           |

**README 与实际的三处偏差**：`README.zh.md:50-58` 写「4 种 Agent 模式」但表格只有 3 行且缺 chat；实际 `SessionMode` 只有 3 个有效值，`cowork/code/acp` 被归一化为 `execute`。版本 badge 仍是 1.0.0（实际 1.0.6）。渠道表格的 ✅ 是代码级而非联调级。

---

## 3. 架构缺失清单

### 3.1 最实锤的一处：`GenerateVideo` 被误隔离

- Main 侧**已有完整实现**：`main/runtime/video-runtime-tool.ts:10-76`（`ToolDefinition`，含 validate/resources/execute，调 `createVideoTaskForWorkspace`）。
- **已注册进工具池**：`main/runtime/desktop-runtime.ts:56` import、`:385` `createVideoRuntimeTool()`。
- 但名字在 quarantine 名单里：`renderer/src/lib/ipc/ts-runtime-text-eligibility.ts:124-133`。快照阶段被剔除 → `run.toolNames` 永远不含它 → `selectExplicitTools` 永远选不中 → **实现和注册都白做**。
- 迁移文档 `docs/migrations/ts-runtime/evidence/tool-catalog-quarantine-and-coverage-2026-11-06.md:113` 写「没有把 GenerateVideo 移植成 Main 侧 TS 工具」，与代码直接矛盾；同文档 `:41` 却声明隔离名单只收「Main 侧确实没有对应工具」的名字。
- 结论：**这是可以低成本恢复的现成能力**，把它移出 quarantine 并补进 allowlist 即可，不需要新实现。

### 3.2 A 类：完全缺失（架构能力，不是功能）

| 缺口                                                  | 证据                                                                                                                                                                                                                                                                                       | 影响                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 统一富内容 run 契约                                   | `contracts.ts:84-88`（`RuntimeTextMessage` 无 `tool` 角色）、`:105-113`（`RunEvent = {type:string; data:unknown}`）；`ts-runtime-text-eligibility.ts:183-188,325-336` 注释自承「reasoning cards, error cards and tool traffic are dropped because the run contract has no field for them」 | UI 完整渲染工具卡片，模型只看得到纯文本 → 长会话「失忆」                |
| 统一能力注册表                                        | 声明散落 6 处：`tools/index.ts`、`app-plugin/types.ts`、settings 开关、`ts-runtime-text-eligibility.ts`、`desktop-runtime.ts`、`run-capability-labels.ts`                                                                                                                                  | 新增插件可能让整会话不可用（提交 `cf6dbb1` 的门禁正是为此打补丁）       |
| 模型能力元数据的 runtime 契约                         | `runtime/providers/model-catalog.ts:8-22` 只有 `id/enabled`；`RunSpec`/`ModelOptions` 不接 `supportsVision`/`supportsFunctionCall`                                                                                                                                                         | runtime 无法按能力选模型，判断在 renderer 与 fallback resolver 各做一遍 |
| 8 家渠道 / MCP / SSH / WebDAV / Cron 的功能级验收证据 | `docs/qa/2026-11-06-full-penetration-test.md:105-109` 明确未覆盖；台账 358/358 是**路由级**                                                                                                                                                                                                | 「迁移完成」不能推导「功能可用」                                        |

### 3.3 B 类：有实现但未接通

- **30 个零引用组件**。其中 `layout/DetailPanel.tsx` 最典型：`ui-store.ts:496,1629` 有 `openDetailPanel`，6 个组件调用它（`ToolCallCard.tsx:953`、`AssistantMessage.tsx:1641`、`StepsPanel.tsx:344` 等），但组件本身零引用 → **状态被设置、无渲染者**。`ui-store.ts:1689` 还在按不存在的 `WorkspaceView` 写逻辑。
- **`desktop_ax_*`**：Main 有实现 `main/runtime/desktop-ax-runtime-tools.ts:470-510` 且在白名单 `:91-97`，但 renderer 从不发布；旧名 `Desktop*` 又被隔离 → **两套命名两边都不可达**。
- **`codegraph_explore`**：Main 有服务 `main/codegraph/ts-codegraph-service.ts`，但未包装成 `ToolDefinition` → 索引可用、Agent 调不到。
- **`CanvasOperation`**：`lib/tools/canvas-tool.ts:34-51` 的 execute 只操作 renderer Zustand，在「工具统一由 Main 执行」的架构下永远没有执行体。
- **事件投影漏项**：`runtime/core/agent.ts:71` emit `tool.start` / `tool.arguments`，`lib/ipc/ts-runtime-projection.ts:119-193` 只处理 6 类事件、不处理这两类 → 流式工具参数被丢弃（功能上 `tool.generated` 已带完整 input，属展示缺失而非不可用）。
- **遗留误导**：`agent-bridge.ts:98-101` 把 `tools`/`planMode` 参数 `void` 丢弃；`ts-runtime-bridge.ts:199-205` 注释仍指向已删除的 legacy path。

### 3.4 C 类：接通但被隔离／降级

- `ts-runtime-agent-eligibility.ts:48-69` 六类闸门：`MODE/SSH/PLUGIN/CHANNELS/TOOLS/MODEL_SOURCE_NOT_MIGRATED` + `WORKSPACE_MISMATCH`，任一不满足即抛 `TS_RUNTIME_AGENT_UNAVAILABLE`，**失败面是整个请求**而非按能力剔除。
- Chat 模式只读窄白名单 6 个工具（`ts-runtime-text-eligibility.ts:16-23`），其余能力静默不可用。
- 图片硬边界：4 张 / 768 KiB / 4 种 mime / 仅 HTTPS URL（`contracts.ts:230-237`），超界直接 fail-closed。
- `main/runtime/runtime-tool-authorization.ts:86-90` 读工具直接 `return true`，绕过统一 Capability 策略。
- JS 扩展 handler 恒返回 `quarantined pending migration`（`main/ipc/extension-js-runtime.ts:7-17`）。

### 3.5 D 类：双轨／重复实现

- **两套工具定义**：renderer `ToolRegistry`（带 `execute`）与 Main `ToolExecutor`（带 `execute`），仅靠名字白名单对齐；渲染侧 handler 在 TS runtime 下永不执行，schema 漂移无法编译期发现。
- **两套事件词汇**：`RunEvent` → `StreamEvent`/`AgentEvent` 靠投影层桥接，`AGENTS.md:42-45` 声称 `RunEvent` 是「单一真值源」，但它是弱类型联合。
- **存储层双形态**：`business-repository.ts` 是 TS 门面，266 KB 的 `business-worker.mjs` 才是 SQL 主体，无同名 `.ts` 源，不受类型系统覆盖。
- **5 套导航状态**：`activeSurface` + 10 个镜像布尔 + `chatView` + hash + `activeSessionId/activeProjectId`；`ui-store.ts:2220-2223` 注释自认「独立 surface 拥有 activeSurface 而 hash 仍指向旧路由」。
- `session-runtime-router.ts` 实为投影/缓冲合并器，名字易被误认为 runtime 选择器。

### 3.6 最值得补的 5 个架构能力（按「一次消解最多缺口」排序）

1. **统一能力注册表**：每个能力一条声明 `name / owner / 开关来源 / Main 工具引用 / 迁移状态 / 文案 key / 审批策略 / 模型能力要求`，由它派生工具快照、白名单、quarantine、设置开关、UI 提示与 CI 门禁。现有可复用基础：`shared/capabilities.ts`、`app-plugin/types.ts:49-113`、`run-capability-labels.ts`、`tests/runtime/renderer-tool-catalog-coverage.test.ts`。
2. **富内容 run 契约**：`RunEvent.type` 收紧为可辨识联合、`data` 结构化；`RuntimeTextMessage` 允许 `role:'tool'`；UI `ContentBlock` 与 runtime 契约共用一套类型。
3. **能力可用性单一真值源 + 健康探针**：汇总模型能力、工具可用性、渠道/MCP/SSH 连接、外部服务健康，供模型绑定、工具快照、UI 提示、Cron 共同消费。
4. **闸门从「请求拒绝」升级为「按能力降级」**：抽象成所有提交入口共用的中间件。当前至少 6 个入口各自提交 run（`chat-send-message.ts`、`use-plugin-auto-reply.ts:1041,1074`、`pet-agent.ts:201`、`translate-agent-service.ts:204`、`prompt-optimizer/optimizer.ts:169`），新增入口极易绕过。
5. **UI 挂载清单 + 可达性 CI 门禁**：断言「每个页面组件至少一个挂载点」「每个 store 状态至少一个渲染者」，据此清理或接通 30 个孤儿组件。

---

## 4. 对话交互链路还原

| 阶段         | 用户动作                                  | 系统响应                                                                                                                                                                | 不自然之处                                                                                                              |
| ------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 冷启动／首启 | 等待 hydration → 选访问方式 → 走 6 步引导 | `App.tsx:1096-1106` 全量门控；昵称/兴趣/SOUL 强制；`App.tsx:346-347` 注释明确「总是回默认首页不恢复上次路由」                                                           | 1+6=7 次交互全阻塞、无 Skip；末步 IPC 失败只 toast 且卡在该步；hydration 重试不再挂 12s watchdog，二次挂起=永久 spinner |
| 新建任务主页 | 选模式/模型/项目目录/场景 → 发第一条      | 模式 `cowork/code→execute` 归一化后**主页无切换控件**（只在侧栏右键 / Ctrl+1/2/3 / 命令面板）；`needsWorkingFolder` 时静默禁发送；`createSession` 在发送时才发生        | 首条前累计约 13–15 个决策；核心概念藏在二级菜单；默认项目名「新建项目 (1)」来自磁盘去重而非 UI，用户无法解释            |
| 发送         | 输入 → 点发送                             | `InputArea.tsx:3256` **立刻清空**；`ChatHomePage.tsx:260-261` 先 `navigateToSession` 再 `sendMessage`；`chat-send-message.ts:250-796` 中间 10+ await 才 `beginUserTurn` | 切到会话页但消息未插入 → `MessageList.tsx:2197-2235` 渲染「第二个欢迎首页」，无发送中反馈                               |
| 流式与工具   | 等回复 → 审批 → 停止                      | `use-runtime-approval.ts:99-115` 用永不 resolve 的 Promise 硬阻塞整条流；`Layout.tsx:1367-1371` 一次只显示一个 toolCall；`RunCapabilityNotice` 要 `!isStreaming` 才显示 | 审批模态打断阅读、不能批量；「记住工具」只有 10px 小字；降级提示流结束后才出现且埋在消息里                              |
| 错误与恢复   | 想重试／编辑重发                          | `throw` 型只全局 toast + 留空 assistant 气泡；`AgentErrorCard` 无重试；`runSimpleChat` 把错误混进正文 `> **Error:**`                                                    | 三种错误三种呈现；错误卡文案「请直接重试」却没按钮；**早退都是 resolve**，草稿恢复只在 `.catch` → 输入静默消失          |
| 多轮与上下文 | 连续提问                                  | 历史有损投影：`thinking/tool_use/tool_result/agent_error/image_error` 全 `continue`，只有工具无文本的轮整轮跳过                                                         | UI 完整保留卡片、模型看不到，多轮后「忘记刚做过什么」，**且无任何提示**                                                 |
| 导航         | 切会话/看标题                             | `Layout.tsx:649-655` 会话页 `title:''`；tab、侧栏树、命令面板、面包屑四处各渲染一次                                                                                     | 会话页顶栏无标题；关 tab 只回 Home、会话仍在侧栏；5 套状态可不同步                                                      |
| 快捷键       | Ctrl+K / Esc                              | 命令面板覆盖 14 workbench action + 10 会话动作 + 模型/profile；`Escape` 在流式时只用于停止生成                                                                          | 不覆盖重试、编辑消息、批量批准、切场景、绑定目录；引导 `mode-switch` / `mode-clarify` 两个锚点全库无组件渲染            |

**「启用自动批准」弹窗的真相**（QA 首次发送被挡的复盘）：

- 它**不在发送链路里**。触发点只有 `TitleBar.tsx:162-171` 与 `Layout.tsx:274-289` 两处，且只在 OFF→ON 弹，无记住选择、无 dismiss 标志。
- 发送链路的三个阻断是：① `chat-send-message.ts:490-516` 的「切换到执行模式？」；② `use-runtime-approval.ts:99-115` 的工具审批模态；③ `InputArea.tsx:4663-4690` 的「启用完全访问？」。
- `PermissionDialog.tsx:438-446` 底部用 10px 小字建议按 `Ctrl+Shift+A` 自动批准，而该快捷键恰好命中 `Layout.tsx:283` 的**另一个二次确认** → 「审批弹窗建议的快捷键触发了另一个全局开关的确认」。三条文案相近，用户感到「一直在确认」是必然的。

---

## 5. 体验问题 Top 10 与最小优化方案

| #   | 现象                                             | 根因                                                                                                                  | 最小改法                                                                                                                                                                                                 | 摩擦类型   |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| 1   | 首启 1+6 步强阻塞、无跳过、末步失败卡死          | `App.tsx:1096-1106`、`OnboardingPage.tsx:82,274-279,722-747`                                                          | `onboardingCompleted` 默认改 `true`，首启改为非模态「完善资料」卡片；`finishOnboarding` 的 catch 也先落 `completed:true` 再 toast；昵称/兴趣/SOUL 改可空                                                 | 一次性     |
| 2   | 三条确认弹窗串联，取消任一即消息不发、输入已清空 | `chat-send-message.ts:490-516`、`PermissionDialog.tsx:438-446`、`Layout.tsx:274-289`                                  | executeSwitch 去掉 confirm，改为照常发送并给 user 消息 `meta.suggestExecute` 渲染可点提示；删掉 Ctrl+Shift+A 小字，换成显式 Checkbox 直接 `addApprovedTool`；给 `confirm()` 加 `rememberKey` 写 settings | 一次性     |
| 3   | 切页后显示「第二个欢迎首页」                     | `ChatHomePage.tsx:260-261`、`MessageList.tsx:1577-1580,2197-2235`                                                     | 发送前写 `pendingFirstTurnBySession[sessionId]`，`MessageList` 在空消息 + 该标记时复用现成三段 pulse 骨架（user 气泡占位 + 「思考中」）；`beginUserTurn` 后清除                                          | 每会话首条 |
| 4   | 预检早退静默吞掉输入                             | `InputArea.tsx:3256` 无条件 `resetComposer()`、`:3260-3273` 恢复只在 `.catch`；`chat-send-message.ts` 十余处 `return` | `onSend` 契约改 `Promise<{ok:boolean;reason?:string}>`，所有 `return` 带 reason；`InputArea` 在 then 里统一调用现成的 `applyEditorStateFromSerializedText` 恢复，并按 reason 给可操作 toast              | 每轮       |
| 5   | 审批硬阻塞、不能批量、记住选择不可见             | `agent-store.ts:2318-2322`、`Layout.tsx:1367-1371`                                                                    | 小字换 Checkbox；加「批准本轮全部 N 个工具」遍历 `approvalResolvers` 批量 resolve；`approvedToolNames` 改按 sessionId 分组，避免 `clearToolCalls` 误清                                                   | 每轮       |
| 6   | 错误三种呈现、留空气泡、错误卡无重试             | `chat-send-message.ts:1630,2687,3310`、`AgentErrorCard.tsx:147-260`                                                   | 主 catch 里若已 `beginUserTurn` 就 append `agent_error` block 而非只 throw；`AgentErrorCard` 加 `onRetry` 接现成 `retryLastMessage`；删掉往正文追加 `> **Error:**`                                       | 失败时     |
| 7   | 有损历史与完整 UI 不一致且无提示                 | `ts-runtime-text-eligibility.ts:254-336`                                                                              | 资格判定返回值多带 `droppedTurnCount`（在两处 `continue` 计数），复用已打通的 `meta.capabilityNotice` 路径让提示条在流开始时显示「本轮有 N 段工具记录未随请求发送」                                      | 每轮累积   |
| 8   | 会话页顶栏无标题、导航状态多套                   | `Layout.tsx:649-655`、`ui-store.ts:767-790,2135-2266`                                                                 | 会话页 `title` 设为现成的 `localizeSessionTitle(...)`；删 `xxxPageOpen` 镜像布尔改 selector；tabIds 由 `sessions.filter(hasTab)` 派生                                                                    | 每轮       |
| 9   | 冷启动永远回 Home，恢复机制写好了没接            | `App.tsx:346-347,367`、`chat-route.ts:128-137`（`readPersistedChatRoute` **全库零调用**）                             | 启动 else 分支先读 `readPersistedChatRoute()`，会话仍存在则 `setActiveSession + navigateToSession`；设置里加 `startupBehavior:'restore'                                                                  | 'home'`    | 每次启动 |
| 10  | 重试/编辑/导出藏在 hover 且文案错                | `AssistantMessage.tsx:3077-3080`、`zh/chat.json:1083`（「重新生成参考」）                                             | 改文案为「重试这条消息」；失败态工具条强制 `opacity-100`；错误卡内联重试；导出统一收敛到 `export-chat.ts:214` 单个 action                                                                                | 每轮       |

### 已经写好、只差接线的机制（9 项）

`readPersistedChatRoute`（零调用）· `addApprovedTool`（批准时已自动调用，但 UI 无可勾选入口）· `retryLastMessage`（完整实现，错误卡不接）· `applyEditorStateFromSerializedText`（草稿恢复只在 reject 时用）· `ConversationGuideDialog`（`conversationGuideSeen` 默认 false 却只能手动打开，且两个 tour 锚点无组件渲染）· `RunCapabilityNotice`（meta 已打通，但 `!isStreaming` 限制）· `CompressionStatusMessage`（`pointer-events-none` 且压缩后不留存）· `RIGHT_PANEL_TAB_ORDER` 只覆盖 5/7 类 · `MESSAGE_CONTENT_NOT_MIGRATED` 修复把崩溃换成静默上下文缺失，应补丢轮计数而非恢复抛错。

**共同特征**：这些机制都不需要新功能开发，只是「实现在，接线没接」。这是本项目交互优化性价比最高的一类。

---

## 6. 建议实施顺序

**第 1 批（低风险、体感提升最大，建议先做）**
Top 4 输入不丢失 · Top 3 发送中骨架 · Top 2 弹窗收敛 · Top 6 错误卡重试 · Top 8 会话页标题 · `GenerateVideo` 移出 quarantine（现成能力恢复）。

**第 2 批（体验一致性）**
Top 5 审批批量与记住选择 · Top 7 丢轮提示 · Top 9 恢复上次会话 · Top 10 文案与入口收敛 · 补齐 `RIGHT_PANEL_TAB_ORDER` · 主页增加可见的模式切换控件。

**第 3 批（架构级，需排期与回归）**
统一能力注册表 → 闸门改按能力降级 → 富内容 run 契约 → UI 挂载门禁 → 清理 30 个孤儿组件。这一批会动到跨进程契约，建议配合 `verify:ts-migration-exit` 与 Electron 端到端用例一起做。

**产品决策项（需你拍板，不建议直接改）**：首启引导是否改成非模态（涉及首次使用的产品定位）、默认项目目录是否还要自动加 `(1)` 后缀、默认启动行为是恢复还是回首页。

---

## 7. 边界与未覆盖

- 8 家渠道、MCP 实连、SSH 远控、WebDAV 同步、图片/视频生成、Cron 真实触发——均需外部账号或设备，本轮只做代码级判定。
- 上述结论基于 `d86a0bb` 源码；`out/` 产物为 2026-11-06 22:39 重建版本，`dist/mac-arm64/Electron.app` 仍是旧打包。
- 未验证真实多轮会话在当前修复后的运行时行为（上一轮 QA 的 P0 已修源码，但 UI 复验留给用户）。
- 本轮未启动任何应用窗口、未消耗模型额度、未改动任何产品代码。
