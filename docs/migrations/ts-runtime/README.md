# Ola TS 运行时迁移记录

> 当前状态（2026-09-20）：生产源码、开发启动、核心 CI、当前 `out` 构建和六份 staging 目录均已切换到 TypeScript/WASM；生产依赖图与产物扫描未发现可达的 `.NET Native Worker`、.NET CodeGraph 或旧外部 Worker 路径。验收台账的 358 条路由与 18 个 CodeGraph 语言项为 376/376；P0、P2–P9、P11 已通过。严格退出仍缺完整 Electron/功能页人工验收、真实主站联调，以及六平台原生安装／升级／启动／签名证据。阶段进度只以[验收台账](acceptance-ledger.json)和最新[验收报告](acceptance-report-2026-09-20.md)为准；下方按日期保留的旧记录只说明当次验证，不代表当前生产路径。

后续执行顺序、证据要求和严格退出条件见 [补充验收基准](SUPPLEMENTAL-ACCEPTANCE.md)。

> 当前 Cron 收口（2026-09-20）：定时触发、手动运行、取消和运行状态查询均固定走 TS 执行器；旧 Cron 执行器、运行时选择器和遗留资格判断已从源码树移除。本文下方较早的 Native/回退描述是历史记录，不代表当前生产路径。当前完成状态只以[验收台账](acceptance-ledger.json)和最新[验收报告](acceptance-report-2026-09-20.md)为准。

> 2026-09-20 频道 SSH 入口收口：频道自动回复不再因会话绑定 SSH 连接而无条件回退旧 Agent；TS Run 现在携带经过 Main 授权的 `sshConnectionId`，并保留无效连接的显式拒绝。Node/Web 类型检查、构建和相关全量回归保持通过。

> 2026-09-20 本轮继续收口：修复生产 TS BusinessRepository 下渠道任务入队后不再 flush 的断路；Main Provider secret gateway 改为仅一次迁移旧 `config.json` 密钥到加密存储，运行时不再把旧值作为回退源。新增供应商密钥迁移回归，渠道任务交付专项 **14 项**及密钥专项 **5 项**通过，Node 类型检查通过。迁移仍未完成：Agent/渠道/团队等完整 parity、跨平台实机验收和所有 legacy 路由清理仍在进行。

> 2026-09-20 本轮收口验证：生产态旧 Agent bridge 在能力探测失败时快速返回，不再为 `sidecar:start` 触发 Native Worker 重试；Native start/recycle IPC 在默认生产配置下显式拒绝，避免白屏窗口进入无限等待。`npm run build`、`npm run test:runtime`（237 个测试文件／863 项测试）、`npm run verify:release-gates`、`npm run verify:ci-core` 及 macOS/Linux/Windows 三平台 runtime staging 完整性均通过。该修复改善启动体验，但不改变迁移完成度：旧 Agent runtime 与部分 legacy route parity 仍未完成。

> 2026-09-20 真实用户库 handover 预检：对当前本机 `data.db` 只读执行 legacy contract 校验，约 153 MB 数据库的业务表与 Wiki schema 均通过；临时目录内生成 backup、manifest、rollback baseline，`verify-legacy-handover` 与 `drill-legacy-rollback` 均成功，源库未切换、未写入。该证据证明真实数据可迁移与可回滚，但不代替用户确认后的生产 ownership 切换。

> 2026-09-20 Settings 体验门禁纳入核心 CI：`verify:settings-visual`、Settings registry scan 与 settings typecheck 现在由 `verify:ci-core` 强制执行；本轮视觉契约、国际化审计、Settings registry/typecheck 和核心 CI 全部通过。

> 2026-09-20 macOS arm64 staging 历史记录：该次构建与重启测试通过；记录中涉及旧 Worker 的构建步骤以当时流水线为准。产物仍未完成 Developer ID 签名／公证，也不能代表六平台原生验收。

> 2026-09-20 三平台 staging 资产门禁复验：macOS arm64、Linux arm64 和 Windows arm64 unpacked 产物通过 `verify-runtime-staging`；默认包不含 `Ola.Native.Worker`，但仍包含独立 .NET CodeGraph。该结果不替代对应系统实机启动／安装验收。

> 2026-09-20 macOS staging handover restart 复验：使用 `dist-staged-mac/mac-arm64/Ola.app` 运行 `verify:electron-handover-restart`，1 个文件／1 项测试通过；重启阶段仍能在 Native 启动前恢复 TS ownership。

> 2026-09-20 Electron workspace IPC 门禁收口：多窗口／工作空间路由验证正式纳入 `verify:ci-core`，不再只作为独立手动命令；新增门禁与全量核心 CI 通过。

> 2026-09-20 阶段 22 体验门禁收口：`verify:ci-core` 进一步纳入 Task Board、Workbench Registry、只读工具并行、Run Lifecycle、Settings routes、Product Experience、Task Profile 和用户可见错误专项；同时修复 `verify:run-lifecycle` 的 Node 侧 Renderer IPC/store 隔离，核心 CI 全量通过。

> 2026-09-20 Native Project Wiki 语义归档迁移：TS handover 现在统计并保留旧 `wiki_documents`／`wiki_generation_runs`，在 TS-owned archive 中校验文档与生成记录数量；预检显示 warning，归档不完整时仍在 Promote 前失败。旧文档不被错误转换成代码索引 Wiki。全量回归 **236 个测试文件／855 项测试通过**。

> 2026-09-20 全量 CI 门禁收口：`verify:ci-core` 新增纳入 SSH Store／重连／续传、Provider Main Store、Draw Graph 四个切片与媒体 runtime 专项验证，避免阶段 15–21 只存在独立脚本而未进入核心 CI。扩展后的核心门禁全量通过。

> 2026-09-20 上下文压缩 TS-first：长对话压缩现在优先通过 TS Runtime 生成摘要，并保留安全边界、原始任务、工具调用/结果、压缩边界元数据和最近消息；TS 不可用或摘要失败时继续回退 Native sidecar，专项回归覆盖 TS 摘要、工具对边界和 sidecar 回退。全量回归 **236 个测试文件／855 项测试通过**。

> 2026-09-20 通用辅助文本入口收口：共享 `runSidecarTextRequest` 现在对标题、Git 提交信息、宠物 claim、Draw Prompt、记忆和推荐等无工具纯文本请求优先使用显式 workspace/model 绑定的 TS Runtime；不满足资格或运行失败时保留 sidecar fallback。定向文本资格回归 **46 项通过**。

> 2026-09-20 普通 Chat 图片路径收口：TS Runtime 已支持的受限 PNG／JPEG／GIF／WebP 图片不再因“存在图片”被入口无条件绕过；只有不满足 workspace/model、provider 或内容边界的图片请求继续走 provider-only 兼容路径。全量回归 **235 个测试文件／851 项测试通过**。

> 2026-09-19 自动模型路由与频道工具收口：自动模型分类器现在优先使用显式 workspace/model 绑定的 TS Runtime；频道自动回复的 TS 工具快照扩展到 Main 已实现的群摘要、音频/视频、@成员、催办和 Bitable 工具，避免 Renderer 过滤造成静默 sidecar 降级。定向资格回归 **20 项通过**；完整回归待本轮最终验收执行。

> 2026-09-19 辅助文本工作流迁移切片：Final Outcome 汇总与 Skill 安全审查在显式 workspace/model 绑定和 TS Runtime 可用时优先走 TS 文本运行；Prompt Optimizer 现通过 Main-owned `WriteOptimizedPrompts` 结构化工具写回 1–3 个选项；无安全绑定时保留 sidecar 兼容路径。全量回归为 **235 个测试文件／850 项测试通过**。

> 2026-09-19 翻译 Agent 缓冲工具接管：TS Runtime 新增 Main-owned、按 run 隔离的 `Write`／`Edit`／`Read`／`FileRead` 翻译工具；翻译缓冲只存在于当前运行，不写用户文件，文件读取限制在选定源文件夹，Renderer 继续接收缓冲更新和工具活动投影。新增工具、路径隔离和授权回归。

> 2026-09-19 翻译主流程迁移切片：普通纯文本翻译现在优先进入 TS Runtime，保留图片/复杂内容及未绑定模型的安全回退；Agent 翻译编辑模式在具备显式模型和 workspace 绑定时也优先使用上述翻译缓冲工具。

> 2026-09-19 Pet 主工作流迁移切片：桌面宠物对话现在优先进入 TS Runtime，保留只读项目工具、历史消息、图片、用量和经验统计；仅在 TS Runtime 不可用或工作区／模型绑定无法安全解析时回退 sidecar。类型检查、Lint、构建、release gates 与全量回归 **233 个测试文件／844 项测试通过**。

> 2026-09-19 真实数据库 handover 兼容性收口：预检识别当前 Native Project Wiki schema；TS handover 副本会保留新版表为版本化归档，并建立旧扫描 Wiki 的兼容表，避免真实 `~/.ola/data.db` 因 schema 漂移被误判为不可迁移。真实库复制副本已完成 v1–v3 ledger、TS Wiki 读写验证；原库未切换 ownership。全量回归 **233 个测试文件／841 项测试通过**。

> 2026-09-19 团队终态投影修复：后台 TS 子 Agent 失败或取消时，团队任务现在分别持久化为 `failed`／`cancelled`，不再误报 `completed`；Renderer 的团队任务列表、状态图标、进度和迟到更新保护已同步支持两个终态。定向回归 **3 个文件／8 项测试通过**。

> 2026-09-19 统一执行记录契约起步：新增共享 `ExecutionRecord` 归一化层，并接入受窗口工作空间授权保护的 `execution-records:list` MessagePack IPC，将 TS 聊天运行与 Cron 运行投影为同一份脱敏结构，包含工作空间、项目、SSH 主机、状态、审批、工具失败、命令/投递摘要、文件变更、产物和失败原因；控制字符、长度、数量和未知状态均有界处理，新增回归。右侧面板已接入该列表，支持工作空间切换、刷新、空态和错误重试；详情跳转与阶段 23 的完整产品闭环仍待补齐，暂不宣称阶段 23 已完成。

> 2026-09-19 阶段 23/25 体验收敛：统一执行记录支持展开查看会话、SSH、文件变更和产物，并可跳回关联会话；审批拒绝状态纳入归一化。能力中心新增本地 Agent、SSH、频道、Cookie、媒体和统一审计的 Prototype/Internal/Beta/GA 生命周期声明；Chat Home 新增本地代码、远程诊断、自动化通知三条首次成功路径入口，均复用现有运行逻辑。类型检查、Lint 与 **233 个 runtime 测试文件／841 项测试**保持通过；真实 Provider/SSH/渠道、跨平台原生启动和生产 ownership handover 仍需外部环境验收。

> 2026-09-19 发布 staging 修复与验收：发布 staging 复制 `.app` 时保留 Electron Framework 的相对符号链接，并在 `verify-runtime-staging` 中拒绝断链或逃出产物根目录的链接；重新生成 macOS arm64 DMG/ZIP 后，runtime staging 完整性与 `verify:electron-handover-restart` **1/1** 通过。通用 electron-builder 入口在本机因完整开发依赖树 OOM，staging 入口可正常完成；本机无有效 Developer ID，仍未完成正式签名／公证。当前完整 runtime 回归为 **232 个测试文件／837 项测试通过**。

> 2026-09-19 Plan Mode TS 接入与交互回归：Main TS Runtime 新增 `EnterPlanMode`／`ExitPlanMode` 的工作空间限定持久化、`AskUserQuestion` 的 question interaction、`Agent` 兼容入口和 `visualize_show_widget` 结果工具；Renderer 已接入 question 回答、计划状态刷新和 camelCase 计划投影。新增 Plan Mode 资格与工具行为测试；随后补齐 SSH 运行契约后全量 runtime 回归现为 **232 个测试文件、836 项测试通过**。这仍不等于 Native Worker 生产写入所有权已退役，也不覆盖真实供应商端点及跨平台原生启动验收。
> 2026-09-19 SSH Agent TS 接入：运行契约携带经过校验的非敏感 `sshConnectionId`，Main TS Runtime 提供空间授权后的远程 `Read`／`LS`／`Glob`／`Grep`／`Write`／`Edit`／`Bash`，凭据继续留在 Main／Native SSH 数据面；远程 `.plan/<id>.md` 生命周期与计划审批读取已接入，绑定 SSH 连接的 Plan Mode 现可进入 TS Runtime。全量 runtime 回归现为 **232 个测试文件、836 项测试通过**；真实远端 Electron 端到端仍待对应环境验收。

> 2026-09-19 跨平台 staging 复验：同一当前构建通过 release staging 生成 Linux arm64 与 Windows arm64 unpacked 目录，`verify-runtime-staging` 分别校验主程序、TS read/write Worker 与 Native Worker 资源通过；当前 macOS 主机不能替代 Linux/Windows 原生启动、安装器和签名验收。

> 2026-09-20 Provider Main secret gateway：Provider 密钥写入／读取现在会同步到 Main-only 加密 secret store；TS 桌面文本与图片运行优先通过 Main gateway 解析密钥，Renderer 仍只接收脱敏镜像，Electron 未就绪时使用会话内存态。旧 `config.json` 密钥仍保留作为 Native 共存回退，故供应商密钥的唯一生产数据源切换和旧 Worker 退役尚未完成；新增 secret store、图片、协议与桌面运行回归后，全量 runtime 为 **237 个测试文件／858 项测试通过**。

> 2026-09-19 TS RunSpec 配置贯通：`responsesSessionScope` 现从 Provider 配置投影到受限公开 `ModelOptions`，通过 256 字符与控制字符边界校验，并用于本地 Responses WebSocket session pool；新增配置解析、资格层和传输复用回归。

> 2026-09-19 Responses WebSocket transport 补齐：本地 `openai-responses` 且配置显式 `ws/wss` 地址时，TS Runtime 通过 workspace/session/scope 隔离的可复用 WebSocket 发送 `response.create`，将事件适配到既有 Responses codec；鉴权头、URL、4 MiB 单帧、取消、并发忙保护和 HTTP fallback 已覆盖行为测试。`disabled`、未配置 WS 地址和托管模型仍走 HTTP；托管账户 WS gateway 与真实 Provider 联调仍是剩余尾项。

> 2026-09-19 托管 Responses HTTP 补齐：远端 Go gateway 新增 `/v1/responses`，复用 workspace/resource/session 绑定的短期 ticket、provider 安全 URL 和 32 MiB 请求边界；此前桌面虽允许 `responses` endpoint，服务端只有 Chat Completions 路由，现已补上 ticket 与团队模型配置回归。

> 2026-09-19 大图附件 staging 补齐：TS Runtime 对 PNG/JPEG/GIF/WebP 图片先由 Main 按 workspace 隔离写入受保护资产目录，RunSpec 仅携带 assetId，Provider 编解码阶段再由 Main 读取并转换为对应格式，绕过 Unix-socket 1 MiB frame 限制并保留单图 20 MiB 上限；prompt 与 history 均覆盖，资产校验、workspace 隔离和编解码回归已纳入。当前完整 runtime 回归为 **228 个测试文件／825 项测试通过**。Responses WebSocket、真实 Provider 端点联调和生产数据所有权切换仍未达到默认路由门槛。

> 2026-09-19 CodeGraph TS 关系查询补齐：`callers`／`callees`／`impact` 现基于独立 WASM 符号与引用索引提供有深度和数量上限的跨文件关系结果；对无法可靠解析的语言继续显式回报 grammar unavailable，不把不兼容 WASM grammar 当作可用能力。

> 2026-09-19 CodeGraph TS analytics 补齐：Main-owned TS/WASM 适配器现在基于独立索引的 import/reference 数据计算文件依赖循环，并按非导出且无引用符号生成稳定 dead-code 候选，结果限额与 .NET 面板契约一致；新增循环与 dead-code 回归。跨文件调用解析、嵌入式语言和性能对照仍未达到默认路由切换门槛。

> 2026-09-19 TS 多模态小载荷接入：Execute／Chat 的 TS Runtime 现在可传递受 768 KiB 总预算约束的 PNG/JPEG/GIF/WebP base64 或 HTTPS 图片，history 与当前 turn 均投影到各 Provider codec；超预算、非 HTTPS URL、rich blocks 和未迁移高级能力仍准确回退 sidecar，Run list 不暴露图片载荷。

> 2026-09-19 workspace v2 全业务表覆盖补齐：TS Business Worker 的同步 allow-list 现覆盖 `qq_wakeup_windows_v2` 与 `wiki_documents`／`wiki_nodes`／`wiki_file_snapshots`／`wiki_generation_runs`，总计 37 张 workspace-owned 表；新增 schema v3 为 Wiki 记录补充 `workspace_id` 并保留旧个人键兼容读取，团队 Wiki 与 QQ wakeup 已纳入真实 workspace bundle 回归。生产 handover 仍保持显式确认与可回退，不改变 Native 默认所有权。

> 2026-09-19 本轮最终验证：WebContentsView 默认宿主已开启，保留 `OLA_BROWSER_USE_WEBCONTENTS_VIEW=0` 显式回退；工作台支持将会话标签拖入内容区形成 workspace/window-scoped 分屏；类型检查、Lint、完整 `npm run build`、`verify:ci-core`、Electron IPC 及 runtime 回归全部通过，runtime 为 **227 个测试文件／818 项测试**。默认配置 Electron 主界面完成首次启动向导后真实冒烟通过；当前版本重新执行 `build:mac:staged` 生成 arm64 macOS DMG/ZIP，unpacked runtime staging 完整性通过；当前产物未签名／公证，因本机无有效 Developer ID 证书。
> 2026-09-19 P11 WebContentsView 事件投影：Main-owned WebContentsView 现在将页面自身的加载开始／结束、主导航、页内导航、标题变化和非取消加载失败通过受控 `browser:view-event` 通道投影到对应宿主 Renderer；地址栏、标题、前进后退、加载态和错误提示不再只依赖工具栏 IPC 返回。新增服务事件回归；本轮最终 runtime 回归 **226 个测试文件、815 项测试通过**。
> 2026-09-19 团队任务协议闭环：Main 与 Renderer TS Runtime 现完整提供 `TeamTaskCreate`／`TeamTaskUpdate`，覆盖任务 ID、负责人、依赖、状态和报告的边界校验、重复任务与非法依赖拒绝，并纳入统一工具授权和 system prompt；后台队友终态会回写任务报告。新增团队任务协议与 manifest 并发回归；本轮最终 runtime 回归 **226 个测试文件、815 项测试通过**。
> 2026-09-19 团队停止协议闭环：TeamRuntime member 记录现在保存后台 TS 子运行 `runId`；停止成员会在 workspace-scoped JSONL 写入 `shutdown_request` 后调用受授权的 `run.cancel`，终态回写清除运行标识。新增实际取消调用断言；完整回归待本轮最终验收执行。
> 2026-09-19 团队任务投影闭环：后台 TS `Task` 在注册队友时同步创建 workspace-scoped manifest task，并在子运行终态回写任务报告与成员状态；TeamPanel 增加任务状态展示，避免只显示成员而丢失任务进度。新增后台任务投影回归；完整回归待本轮最终验收执行。
> 2026-09-19 P12 主站模型契约切片：`server/` 新增与桌面 `account-client` 对齐的 workspace directory、脱敏 model resources 和短期 model access ticket；ticket 绑定账户、设备、workspace、resource、session，并在 `/v1/chat/completions` 侧验证后才进入 provider gateway。新增 Go 端账户目录／票据／gateway fail-closed 回归；真实部署、供应商计费、跨平台安装签名仍未完成。
> 2026-09-19 P11 WebContentsView 默认宿主：WebContentsView 现默认启用，保留 `OLA_BROWSER_USE_WEBCONTENTS_VIEW=0` 的显式回退开关；创建失败仍自动回退 `<webview>`。Main 侧所有权、bounds、导航、页面事件和 HTTP(S)/新窗口安全边界已接入，真实登录流程与人工视觉验收仍待完成。
> 2026-09-19 P11 Renderer 宿主接入：BrowserPanel 默认创建并销毁 Main-owned WebContentsView，按容器 ResizeObserver 更新 bounds，工具栏导航复用新的受 host 所有权保护的 IPC，并把 view 的 webContents 注册回现有浏览器控制／取消链路；创建失败自动回退 `<webview>`，`OLA_BROWSER_USE_WEBCONTENTS_VIEW=0` 可显式关闭。新增跨 host 销毁拒绝回归；真实登录流程和人工视觉验收仍待完成。
> 2026-09-19 本轮最终验收：workspace v2 冲突选择 UI 已接入托管个人／团队同步入口；修复 ChatHomePage 的 workspace project selector 在 React 19 下生成不稳定 external-store snapshot 导致的启动更新循环，并将 TeamPanel 改为订阅稳定团队快照。真实 Electron 主界面启动验收通过；生产构建、类型检查、Lint、225 个 runtime 测试文件／812 项测试及 `verify:ci-core` 全部通过。默认 Native→TS 生产所有权、完整团队并行协议、六平台原生验收和 P12 主站／发布集成仍未完成。
> 2026-09-19 团队 UI 控制闭环：TeamPanel 的停止成员／停止全部现在通过 workspace-scoped TeamRuntime JSONL 写入 `shutdown_request`，不再调用空的 Native 控制桩；面板手动消息先持久化再更新本地投影，避免刷新后丢失。新增 2 项控制行为测试，终态成员不会重复发送关闭请求。
> 2026-09-19 workspace v2 全域同步接入：Business Worker 现在按 allow-list 捕获并事务化提交 31 个 workspace-owned 业务表（含 sessions/messages/plans/tasks/Cron/memory/usage/Draw/agent/runtime/desktop flows 及其关系表），支持关联表通过 workspace owner 过滤、revision 防并发覆盖、基线与 tombstone；TS 通用冲突合并器已接入 WebDAV v2，Main IPC 与 Renderer Sync 页面提供 workspace-scoped 触发入口。Global/device 表仍明确排除，Native→TS handover 仍需先完成并获得有效 TS writer ownership；本轮新增真实 handover 全域同步回归。
> 2026-09-19 workspace v2 自动同步：TS ownership 已提升且启用自动同步时，Main 按本地个人／离线授权团队 workspace 去重执行 v2；未登录且没有 managed workspace 目录时保留个人 v1 离线兼容路径，避免把 account-bound v2 scope 错当成无账户授权。
> 2026-09-19 Feishu 音视频发送迁移切片：新增 `FeishuSendAudio` 与 `FeishuSendVideo` Main-owned TS 工具，分别固定 `opus`／`mp4` 类型、校验扩展名、workspace/channel/chat 授权，并复用受控 Feishu upload/send IPC；复杂的渠道入站媒体解析、转码和跨平台真实账号验收仍待完成。
> 2026-09-19 团队快照实时投影补齐：Renderer 团队 inbox poller 现在与消息消费合并为 workspace-scoped 单轮询，同时刷新 TeamRuntimeStore manifest 快照；后台队友状态、任务终态和报告可自动进入 TeamPanel，团队切换会丢弃旧请求，停止 poller 会清理去重与审批状态。新增 **2** 项行为测试；全量回归需重新执行。
> 2026-09-19 后台团队子 Agent 终态闭环：scheduler 现在支持一次性的 nested terminal projection；后台子 Agent 完成、失败或取消后会回写团队成员状态、currentTaskId、completedAt，并在已有团队任务时写入报告。新增调度器终态投影回归，当前定向验证 **17 项通过**；团队 UI 实时投影、完整并行协作协议和真实 Electron 端到端验收仍待完成。
> 2026-09-19 团队 Agent TS 接入切片：TS Run 新增经过边界校验的团队上下文，Main TS Runtime 接入 `TeamCreate`、`SendMessage`、`TeamStatus`、`TeamDelete`，复用 TeamRuntimeStore 的 manifest／JSONL 持久化与显式工具授权；团队 Agent 不再因 active team 被资格层无条件回退 sidecar。当前仍未完成队友子运行的完整 UI 投影、并行调度协议、权限／计划交互闭环和真实 Electron 团队端到端验收，不能据此宣告团队域完成迁移。
> 2026-09-19 团队子 Agent 语义修复：Main `Task` 现在保留 `team_name`、成员名和任务 ID，后台队友注册到团队 manifest，并将团队上下文与 Team 工具能力传入独立子运行；`createAgentExecutor` 也不再丢失 scheduler 的嵌套运行句柄。后台队友完成后的 UI 投影、任务终态回写和真实并行协作验收仍待完成。
> 2026-09-19 团队空间隔离补齐：TeamRuntimeStore 的 manifest／JSONL 路径按 workspace 哈希分区，同名团队在个人与团队空间不再串读；Renderer runtime-client 自动带当前工作空间，Main Team IPC 校验已登记窗口空间及离线授权。兼容旧的无 workspace 参数存储路径，旧团队数据仍需显式迁移验收。
> 2026-09-19 托管图片资源绑定补齐：TS Run 可携带独立 `imageModelSource`，图片工具不再把聊天模型资源误用为图片资源；托管图片请求仍通过 Main account ticket，local／托管图片生成均有路径、响应大小、模型类型和 workspace 隔离测试。全量 Runtime 回归现为 **222 个测试文件、799 项测试通过**。
> 2026-09-19 ImageGenerate 接管：Main TS Runtime 新增受 workspace 资源锁保护的 `ImageGenerate` 工具，local provider 只使用 Main provider mirror，托管模型只通过 Main account ticket 调用 `images/generations`；响应大小、数量、尺寸、质量和模型类型均有边界，生成 PNG 按 workspace 保存到受保护目录并返回文件元数据。大附件 staging、Responses WebSocket、协议全量多模态能力及真实端点联调仍待完成；ImageGenerate 工具单测通过。

> 2026-09-19 TS 子 Agent 调度接管：Main TS Runtime 新增受父运行约束的 `Task` 工具，支持同步子运行与后台子运行提交；同步任务使用独立 session 并复用持久化 scheduler/journal、取消和交互通道，子任务工具快照自动移除 `Task` 防止递归。后台子任务使用 `subagent:` 运行标识，仅按显式权限策略授权写工具；无人值守频道仍禁止生成子 Agent。调度器父子运行、能力继承、后台提交和安全拒绝测试通过。后台队友的完整 UI 投影、团队协作协议和真实 Electron 验收仍未完成。

> 2026-09-19 Goal 资格门接线：Goal 工具完成 Main TS 接入后，Execute 资格不再因“已有 Goal”无条件回退 sidecar；`get_goal/update_goal` 可在已有 Goal 会话中使用，计划、SSH、团队和未迁移 Goal 相关高级路径仍保持独立门禁。

> 2026-09-19 Goal 工具接管：`get_goal`、`create_goal`、`update_goal` 已接入 Main TS Runtime；创建仅在当前 session 无 Goal 时允许，更新只接受 `complete/blocked`，所有读写绑定当前 workspace/session。非后台运行沿用原有免审批语义，后台运行不会借此获得 Goal 写权限；Goal UI 会在工具完成后刷新。

> 2026-09-19 Task 工具接管：`TaskList`、`TaskGet`、`TaskCreate`、`TaskUpdate`、`TaskDelete` 已接入 Main TS Runtime，所有读写固定绑定当前运行的 session/workspace，并复用现有 workspace-scoped tasks DAO；跨会话读取、非法状态、超长字段和越界关联均拒绝。Renderer 任务面板与旧 IPC 仍保持兼容，后续需补 UI 实时投影与 Electron 多窗口验收。

> 2026-09-19 频道自动回复资格收紧：TS 频道路径现在显式声明并校验 `pluginId/chatId/messageId` 运行上下文；未绑定频道上下文的插件／渠道工具请求继续回退 sidecar，绑定上下文的 unattended 运行才可进入 Main 授权层。新增资格回归覆盖，避免频道写工具绕过运行目标绑定。

> 2026-09-19 Renderer 工具桥接补齐：MCP 动态工具／资源不再返回 Native-only 占位，现通过 Main 的可信 MessagePack IPC 调用已连接 MCP 管理器；桌面截图、点击、键盘输入、滚动和等待工具也已接入现有 Main TS/IPC 实现，并保留取消、参数边界和结构化错误结果。新增 Renderer MCP 行为测试；全量 runtime 回归 **218 个测试文件、783 项测试通过**。默认业务数据所有权、渠道复杂媒体与真实 Electron 多窗口验收仍是后续收尾项。

> 迁移预检补齐：Settings 的业务 handover 状态现在只读验证 legacy 数据库契约、备份目录安全性与预计快照空间；不满足条件时显示具体阻塞原因并禁用提升按钮。预检不会创建快照，合法源库、首次目录和符号链接失败路径均有专项覆盖；当前全量 runtime 回归 **216 个测试文件、779 个测试通过**。

> 浏览器宿主生命周期行为验收补齐：新增 MainBrowserService 行为测试，真实触发宿主 WebContents 销毁后确认其全部 tab 登记和用户控制租约失效；静态安全门禁与 Node 类型/Lint 均通过。

> 独立会话窗口 IPC 收紧：打开与聚焦 detached session 的入口现在要求可信、已登记工作空间的主 frame，避免 guest/子 frame 代替宿主创建或操控会话窗口；产品体验门禁已覆盖该约束。

> handover 预检提示优化：设置页将数据库契约、备份空间、备份目录和源库不可用等内部错误码转换为可读提示，未知原因仍保留原始诊断信息；Renderer 类型检查、Lint 与产品体验门禁通过。

> 团队工具接管补齐：Renderer 的 TeamCreate、SendMessage、TeamStatus、TeamDelete 不再返回 Native-only 占位错误，现通过 Main TS TeamRuntimeStore 的 IPC 读写团队 manifest 与 JSONL 消息；团队运行时 JSONL、Renderer 类型检查及产品体验门禁通过。

> 本轮验证：渠道恢复、运行上下文绑定写工具、Renderer 渠道 IPC、Feishu 成员查询、图片发送、文件发送、成员 @ 提及、紧急消息、Weixin 图片／文件及 Bitable 读写改动后，`npm run lint:ci`、`npm run typecheck`、`npm run build`、`npm run verify:ci-core` 全部通过；runtime 回归 **215 个测试文件、774 项测试通过**。

> 渠道读取桥接补齐：`PluginGetCurrentChatMessages` 与 `PluginSummarizeGroup` 不再返回 Renderer Native-only 占位错误，现复用 workspace-scoped `getGroupMessages` Main action；TS 资格、Runtime 定义和 Renderer bridge 专项 **21/21** 通过。

> 工作台标签交互补齐：会话标签现在支持在同一窗口／工作空间内拖拽排序，也支持键盘 `Alt+←/→` 调整顺序；排序结果沿用隔离持久化键，未知或跨空间会话 ID 会被拒绝，工作台标签专项 **3/3** 通过。

> 浏览器宿主生命周期收紧：Main browser ownership registry 现在监听宿主窗口销毁，并清理该窗口所有 guest/tab 登记、workspace 控制租约和反向索引，避免窗口重建后残留孤儿浏览器会话；Main browser service 与 webview security 门禁通过。

> 最新 macOS staging 复验：基于当前 build 重新生成 arm64 `Ola.app`，runtime staging 完整性通过；`verify:electron-handover-restart` **1/1 通过**。当前环境仍无有效 Developer ID 证书，签名仅为本地验证，不替代发布签名验收。

> 最新 Linux／Windows staging 复验：基于同一当前 build 重新生成 arm64 `linux-arm64-unpacked` 与 `win-arm64-unpacked`，两者 runtime staging 完整性均通过；当前主机无法替代对应平台原生启动、安装器和签名验收。

> Feishu 媒体写入迁移切片：`FeishuSendImage` 与 `FeishuSendFile` 已接入 TS Runtime provider-specific 写工具、Main 授权执行和 Renderer workspace-scoped IPC；路径、文件类型、内容长度、插件／聊天上下文均有边界校验。Feishu 语音／视频及默认生产所有权切换仍未迁移。

> Bitable 迁移切片：`FeishuBitableListApps`、`FeishuBitableListTables`、`FeishuBitableListFields`、`FeishuBitableGetRecords` 以及创建、更新、删除已接入 TS Runtime 与 Renderer IPC，应用／表／字段、记录数量和序列化大小边界及 workspace-scoped Main 路由均已覆盖。

> Bitable 写入迁移切片：`FeishuBitableCreateRecords`、`FeishuBitableUpdateRecords`、`FeishuBitableDeleteRecords` 已接入受控 TS Runtime 写工具，记录数量、序列化大小、字段／记录 ID 长度与 workspace/plugin 授权均有边界校验。

> Feishu @ 提及迁移切片：`FeishuAtMember` 已接入 TS Runtime provider-specific 写工具，严格绑定插件／聊天上下文，并校验成员 ID、@全体和文本载荷；语音／视频等媒体工具仍待迁移。

> Feishu 紧急消息迁移切片：`FeishuSendUrgent` 已接入 TS Runtime 写工具，按消息 ID、用户 ID 和 app/sms 类型做边界校验，并通过 Main workspace-scoped IPC 执行。

> Weixin 媒体迁移切片：`WeixinSendImage` 与 `WeixinSendFile` 已接入 TS Runtime provider-specific 写工具和 workspace-scoped IPC，路径与文本载荷边界已覆盖。

> Electron handover 重启验收复验：重新生成最新 macOS arm64 runtime staging 后，完整性校验通过；修正 macOS `.app` bundle 启动路径后，`verify:electron-handover-restart` **1/1 通过**，确认 marker 恢复 TS 所有权后打包 Electron 可持续运行而不会提前退出。

> 打包 Electron IPC 复验：最新 workspace-scoped 构建执行 `test:electron-ipc` 通过，覆盖主 frame 授权与多窗口工作空间路由；这仍不替代真实六平台启动和人工视觉验收。

> Linux staging 复验：基于当前构建重新生成 arm64 `linux-arm64-unpacked` 目录包，`verify-runtime-staging` 完整性校验通过；当前主机无法替代 Linux 原生启动和桌面视觉验收。

> Windows staging 复验：基于当前构建重新生成 arm64 `win-arm64-unpacked` 目录包，`verify-runtime-staging` 完整性校验通过；当前主机无法替代 Windows 原生启动、签名和桌面视觉验收。

> 体验门禁复验：`verify:workbench-registry`、`verify:settings-visual`、`verify:product-experience` 与 `verify:media-runtime` 全部通过；其中 product-experience verifier 已同步当前 Settings registry/resolver 架构，避免因旧字符串路径产生误报。

> 业务 handover 合约复验：Native→TS 快照、marker 恢复、写入提升与回退边界专项测试 **9/9 通过**；生产入口现由只读预检、可信主 frame 与二次确认保护，不再要求部署环境变量开关。

> 体验自动化扩展复验：消息列表视口、任务板投影、工作台注册、Settings 视觉契约、产品体验和媒体运行时门禁均通过；这些自动化结果仍不替代真实多窗口人工视觉验收。

> SSH／远程工作区门禁复验：SSH 存储模块、重连诊断、传输续传和配置完整性验证全部通过；SSH 连接配置仍属于 Native 数据域，未因此宣称已完成 TS 数据所有权迁移。

> 发布／设置／国际化门禁复验：release gates、Settings registry/typecheck 和 16 个 locale 的严格 i18n audit 全部通过；1648 个 key 的 fallbackLocales 已清零。

> Feishu 成员查询迁移切片：`FeishuListChatMembers` 已接入 TS Runtime 与 Renderer workspace-scoped IPC，分页和 member ID 类型有边界校验；provider-specific 语音／视频媒体仍待迁移。

> Renderer 渠道工具桥接补齐：通用发送、回复、群消息读取、当前聊天读取、群摘要和群列表工具均经 workspace-scoped `plugin:exec` IPC 调用 Main；provider-specific 媒体与 Bitable 工具也已接入独立 IPC，复杂语音／视频仍待迁移。

> 渠道写工具执行闭环：`PluginSendMessage` 与 `PluginReplyMessage` 已通过 TS Runtime 的 Main 授权动作执行，并绑定工作空间、插件、聊天和回复消息；执行层专项测试通过。复杂渠道媒体工具及默认生产所有权切换仍未完成。

> 渠道 handover 生命周期恢复补齐：成功提升后可通过显式环境开关 `OLA_ENABLE_TS_CHANNEL_RESUME=1` 恢复已隔离的渠道服务；默认仍保持停写／停服务，避免复杂渠道写工具尚未迁移时误恢复旧路径。新增 ChannelManager 恢复行为测试；该开关不代表渠道整域迁移完成。

> Electron 重启链路验收：使用最新 macOS staging `Ola.app` 和真实 Native Worker 生成交接副本／marker 后，启动打包 Electron 进程 10 秒未提前退出，说明启动阶段可在 Native 启动前恢复 TS 所有权；`OLA_STAGING_APP=<path> npm run verify:electron-handover-restart` 通过。Linux／Windows 原生进程仍需在对应系统执行。

> 发布资产完整性验收：`scripts/verify-runtime-staging.mjs` 已统一校验 macOS／Linux／Windows staging 的主程序、TS read/write Worker 与 `Ola.Native.Worker` 资源，三平台现有目录包均通过；最新 macOS staging 重打包后 Electron 重启测试通过。

> handover 所有权验收增强：真实 Native→TS 合约在提升后新增 TS 所有会话，确认新行只出现在 TS 交接库、原 Native 库保持不变，并在关闭／重开仓库后继续可读；专项测试 **7/7** 通过。

> 旧版同步路径接管：handover 后旧 WebDAV 数据库同步的 capture／merge／metadata 三个入口改由 TS Business Worker 执行，继续拒绝把团队记录放入无空间 v1 bundle；真实 Native 快照、TS 合并、Native 原库不变对照测试通过，handover 合约现 **8/8**。

> Native Agent 停写边界补齐：handover quiesce 现在立即关闭 Agent bridge 的运行态并禁止后续 `start/ensureStarted`，避免状态查询、清理或迟到请求隐式重启已停住的 Native Worker；专项 quiesce 测试 **5/5** 通过。

> 重启恢复编排补齐：检测到持久化 handover marker 时，启动阶段现在重新执行完整的 legacy-writer quiesce（渠道、Cron、同步、Agent 及 Native Worker），不再只 park Native Worker，避免后台调度器在恢复窗口向已停写数据库发起迟到请求。

> TS Chat 资格扩展：纯文本 Chat 的 TS Runtime 资格门现在可携带已类型化的 thinking body 参数、budget 与强制 temperature，并保留未知／未配置 thinking 的安全回退；资格单测 **7/7** 通过。

> Cron 原子启动接管：TS Cron 执行在 handover 下改用 Business Worker 的事务化 `startCronRun`，将运行快照创建、一次性任务去重、运行中互斥与 `fire_count` 更新合并为单事务；Native fallback 保持原有两步路径。全量运行时回归仍为 **210 个测试文件、742 项测试通过**。

> 交接体验入口补齐：Settings → Migration 现在显示 TS 业务所有权状态、交接中的回退快照，并通过显式确认调用安全 handover；status IPC 仅接受可信主窗口主 frame。全量类型检查与 runtime 回归通过。

> 提升后读取兼容性补齐：BusinessRepository 现在覆盖 LegacyReadRepository 的全部 61 个原型方法（其中 Main canary 实际调用的 55 个方法已逐一核对），包括 Cron 单次运行、QQ 唤醒资格和 usage overview/raw projection；避免 handover 后因方法名差异触发错误回退。方法覆盖静态核对、QQ/Cron/交接回归通过。

> handover status 安全验收：主 frame／guest／子 frame IPC 授权与 runtime-ready 拒绝路径测试 **3/3**；全量 runtime 回归现为 **214 个测试文件、751 项测试通过**。

> 读取兼容性防回归：新增自动化原型覆盖测试，要求 LegacyReadRepository 的全部 **61** 个方法均存在于 BusinessRepository；当前全量回归为 **214/751**。

> CI 核心闸门复验：`npm run verify:ci-core` 通过，包含 workspace runtime/isolation、SSH／浏览器／凭据安全、TS runtime 资产、同步与 release gates。

> handover 前置安全门禁：业务提升入口现在要求 TS Desktop Runtime 已就绪，并在 Settings 状态中显示 runtime／安全开关状态；未就绪时不会停写 Native。

> TS Agent 工具闭环补齐：`Notify` 不再接受“仅 Native”占位实现；现在通过 Main `notify:desktop` IPC 执行，并对标题、正文和持续时间做边界校验，避免 TS 资格通过后运行时返回迁移占位错误。专项行为测试 **2/2** 通过。

> 渠道纯文本 Agent 接管切片：自动回复对无图片／音频、无 SSH、无插件工具调用的纯文本任务先尝试 TS Runtime，渠道发送仍由 Main 的授权 IPC 负责；复杂能力继续保留 sidecar 回退。该切片为渠道服务恢复后的 TS 接管准备，当前 handover 仍会停写并停止旧渠道服务，不能据此宣告渠道整域完成。资格回归新增覆盖，当前全量 runtime 为 **214 个测试文件、751 项测试通过**。

> 渠道只读工具接管切片：TS Runtime 现在提供 `PluginGetGroupMessages`、`PluginGetCurrentChatMessages` 和 `PluginListGroups`，通过 Main 渠道服务执行并以运行工作空间复核插件归属；参数数量、插件 ID 与聊天 ID 均有边界校验，发送／回复等写工具仍未开放。专项测试新增 **2/2**，全量回归为 **214 个测试文件、751 项测试**。

> handover 重启恢复补齐：提升成功后 Main 以私有原子 marker 持久化 manifest／副本路径；后续启动只要 marker 存在就先恢复 TS 仓库并永久停住 Native Worker，损坏 marker 不会静默回退旧写入者。发起提升需要通过只读预检、可信主 frame 与显式确认。真实 Native→TS 合约测试已关闭并重新打开提升仓库验证空间读取；marker 单测和当前 macOS staging Electron 重启验收通过。全量运行时回归现为 **210 个测试文件、742 项测试通过**。

> Linux staging 当前版本复验：重新生成 arm64 `--dir` 包成功，产物约 499 MiB；`ola`、`business-worker.mjs`、`legacy-read-worker.mjs` 与 `Ola.Native.Worker` 均通过完整性检查。当前主机为 macOS，未执行 Linux 原生启动。

> macOS staging 当前版本复验：重新生成 arm64 `--dir` 包后，主程序、TS read/write Worker 与 `Ola.Native.Worker` 资源完整；应用启动保持 12 秒无提前退出，进程已正常结束。当前机器仍无有效 Developer ID 证书，无法完成公证安装包。

> Windows staging 当前版本复验：`npm run package:runtime-staging -- --win --keep` 成功生成 `win-arm64-unpacked`；主程序、`business-worker.mjs`、`legacy-read-worker.mjs` 与 `Ola.Native.Worker` 资源完整，产物约 550 MiB。由于本机无 Windows 签名证书，仍是未签名目录包。

> 提升后读取覆盖补齐：BusinessRepository 现在补齐项目／任务／计划的全量列表、插件会话列表、渠道状态与复合用量统计等 LegacyReadRepository 兼容入口；handover 后这些读取不会因方法名差异回退到 Native。Node 类型检查与 handover 合约测试通过。

> handover 读路由隔离验收：真实 Native Worker 最后一笔写入停下后，提升的 BusinessRepository 现在直接承接会话列表读取；个人／团队空间均从 TS 副本返回，旧库保持停写。`native-handover-contract.test.ts` 的 7 项测试通过。

> 提升后读取路由补齐：业务 handover 成功后，所有现有 TS read-canary 会自动复用已提升的 `BusinessRepository`，不再继续打开已停写的 Native 数据库；读取关闭开关在已提升状态下也不会把请求退回 Native。全量运行时回归仍为 **208 个测试文件、738 项测试通过**。

> 生产提升入口补齐：Main 现提供受可信主窗口、只读预检和显式确认保护的 `migration:business-handover`，按“旧写入者停写 → 一致快照／回退演练 → TS 仓库提升”顺序执行，并在成功后将业务写入路由提升到该仓库；`migration:business-handover-status` 可查询提升状态。入口不会通过修改环境变量切换，也不会在失败后恢复 Native 写入。该入口已完成接线与 Node 类型／Lint 校验，但尚未在真实用户库上执行生产提升；执行前仍需完整桌面端 E2E、全业务域接管和可回退演练。

> 跨平台 staging 验收：同一运行时依赖白名单在本机成功生成 Linux arm64 `--dir` 包和 Windows arm64 `--dir` 解包目录；Windows 资源签名步骤在无证书环境中可继续完成未签名产物。`lint:ci`、完整类型检查通过。

> 发布依赖分层修复：新增 `npm run package:runtime-staging`，从 Main bundle 的外部依赖清单创建临时 production staging，避免把完整 Renderer 依赖树交给 electron-builder。macOS arm64 `--dir` 打包已成功，应用目录约 464 MiB；直接启动 12 秒烟测无启动错误，原始开发依赖不变。代码 ESLint 与 Node 类型检查通过。

> macOS 发布验收记录：`native:publish`、严格 Worker 资产校验和完整 `npm run build` 均通过；electron-builder 在本机扫描依赖树阶段即使将 Node 堆上限提高到 8 GiB 仍 OOM，未生成可签名安装包。这是当前构建机资源限制，不能当作 macOS 安装包启动验收通过。

> 代码质量闸门复核：`npm run lint:ci` 通过（零 warning、零 error）。

> 最终构建闸门复核：`npm run build`（Main、Preload、Renderer、TS Runtime）通过；`verify:release-gates` 和 Electron 多窗口空间 IPC 测试通过。构建日志仅有既有 chunk/dynamic-import 提示，无错误。

> 本轮全量回归：`npm run test:runtime -- --silent` 通过 **208 个测试文件、738 项测试**；`npm run typecheck` 与 `git diff --check` 通过。新增 Cron 空间接线、QQ 唤醒写入接管和渠道命令／自动回复路由接管均未引入回归。

> P8 QQ 唤醒窗口写入接管：来源记录、唤醒资格查询和已发送标记在 TS handover 下现在统一读写 BusinessRepository，并保留工作空间授权复核；原先该渠道域仍是 Native 写入。QQ 唤醒交接／DAO 工作空间测试 4 项通过，Node 类型检查通过。

> P8 Cron 启动恢复接管：TS handover 下调度器启动恢复会枚举本地个人空间及已授权离线团队空间，按空间执行 TS `cron-recover`，不再从 Native 汇总加载 Cron；未启用 handover 时保持原 Native 路径。类型检查与 Cron 回归通过。

> P8 Cron 触发计数接管：Cron 调度器的 `last_fired_at`／`fire_count` 更新，以及并发跳过运行的创建和终态更新，现在在 TS handover 下带上作业空间并使用 BusinessRepository；之前这些路径会在 TS 写入开启时因缺少空间键中止。Cron 相关回归仍为 9 个文件、15 项通过。

> P8 TS Cron 空间写入接线修复：TS Cron Agent 的运行记录创建、日志追加、消息替换和终态更新现在显式传递作业工作空间；此前在 handover 写入开启时这些后台写入会因缺少空间键而无法安全落盘。Cron 相关 9 个测试文件、29 项测试及 Node 类型检查通过。

> P8 渠道自动回复路由接管：自动回复入口在显式 TS handover 下现在使用 BusinessRepository 的空间限定会话路由（含项目、provider、model 绑定），Native 结果形状仍保留为默认回退；这使真实渠道消息进入 Agent 前的会话选择不再强制依赖 Native 写入者。节点类型检查通过，Worker 路由交接对照测试已有覆盖。

> P8 渠道命令写入接管：`/new` 会话清空和 `/compress` 历史压缩在显式 TS handover 下现在直接调用 BusinessRepository，并继续沿用已核验的插件会话工作空间；默认环境仍保留 Native 回退，避免在交接副本未准备好时误写生产库。Main Node 类型检查通过。

> P8 DB 消息 IPC 空间参数补齐：更新、清空、删除、整会话替换和截断入口现在把 IPC 已核验的 `workspaceId` 继续传入 Main messages DAO；TS 写入门禁因此能在真实 MessagePack IPC 路径执行空间归属校验，而不会因参数丢失退回或错误拒绝。`npx vitest run tests/runtime/business-write-canary-goal.test.ts --silent`（15 项）和 `npm run typecheck:node` 已通过。

> P8 运行时任务通用入口写入 canary：NativeAgentRuntimeManager 的通用请求现在在显式 TS handover 下将任务提交、状态更新、取消和 stale 回收直接路由到 BusinessRepository；请求仍统一校验工作空间，Agent run 本身未受影响。全量运行时回归通过；默认生产调度仍未切换。

> P8 运行时任务访问 canary：NativeAgentRuntimeManager 的任务获取、列表、取消和事件回放现在在显式 TS handover 配置下使用 BusinessRepository，并在进入读取／取消前统一校验离线空间授权；默认仍走 Native。任务提交和执行调度尚未切换，需继续做生产写入和 Agent 端到端验收。

> P8 渠道会话写入 canary：Main channel handlers 的插件会话创建、清空、删除和重命名已接入显式 TS 写入门禁；入口仍先核验插件归属和离线团队授权，删除后继续通知 Renderer。默认生产渠道写入仍保持 Native，消息写入和在线服务端到端接管尚未完成。

> P8 记忆流水线写入 canary：Main memory-pipeline DAO 已接入显式 TS 写入门禁，覆盖记忆根幂等确保、Stage1 输出、记忆任务创建／结束、引用计数和根清理；来源会话和空间由 TS Worker 校验。真实 Native 快照续写测试覆盖阶段输出、任务终态、引用和清理。默认生产记忆流水线写入仍保持 Native。

> P8 Wiki／桌面流程写入 canary：Main capability DAO 已接入显式 TS 写入门禁，覆盖 Wiki 保存／删除、桌面流程保存／删除及流程运行开始／结束；读取 canary 与写入 canary 保持分离。真实交接副本测试覆盖删除、运行终态和个人空间原库不变。默认生产写入仍保持 Native。

> P8 Cron 写入 canary：Main cron DAO 已接入显式 TS 写入门禁，覆盖定义创建、更新、启停、软删除、硬删除，以及运行记录创建、终态更新、消息替换和日志追加；Cron 消息按 TS Worker 约定序列化为 JSON。真实 Native 快照续写测试覆盖定义与运行记录生命周期和原库不变；调度器实际接管仍未完成，默认生产 Cron 写入仍保持 Native。

> P8 自动记忆写入 canary：Main memory-automation DAO 已接入显式 TS 写入门禁，覆盖自动记忆记录写入、撤销和 rollup 水位标记；空间键显式传入，证据 JSON 在 TS 路径保持持久化。真实 Native 快照续写测试覆盖撤销状态、rollup 记录和原库不变。默认生产记忆写入仍保持 Native。

> P8 子 Agent 历史写入 canary：Main sub-agent-history DAO 已接入显式 TS 写入门禁，覆盖按会话应用、整会话替换和迁移标记；调用方可显式提供已核验空间，旧调用缺失空间时不会在 canary 中猜测。真实 Native 快照续写测试覆盖完成状态、迁移标记和原库不变。

> P8 Agent 变更写入 canary：Main agent-changes DAO 已接入显式 TS 写入门禁，覆盖文件变更追加、撤销标记、运行状态重算和已完成变更保留期清理；空间归属由 TS 仓库校验，跨空间重算保持幂等 no-op。真实 Native 快照续写测试覆盖变更快照、撤销状态和原库不变。默认生产写入仍保持 Native。

> P8 用量事件写入 canary：Main usage-events DAO 已接入显式 TS 写入门禁，覆盖带空间的事件新增和时间范围删除；TS 路径继续保留离线空间校验，统计读取 canary 与写入 canary 分开控制。真实 Native 快照续写测试确认 TS 删除不修改 Native 源库。定期全局维护仍由 Native 持有，默认生产写入未切换。

> P8 绘图运行写入 canary：Main draw-runs DAO 已接入显式 TS 写入门禁，覆盖按空间保存、删除和清空，并在进入写入前继续执行离线团队授权校验。真实 Native 快照续写测试覆盖个人空间和原库不变；团队空间未授权会硬拒绝。默认生产绘图写入仍保持 Native。

> P8 消息写入 canary：Main messages DAO 已接入显式 TS 写入门禁，覆盖单条／批量新增、upsert、局部更新、整会话替换、截断、按角色删除末条、按 ID 删除、清空和 artifact 插入入口；需要工作空间的旧调用在 canary 开启时会硬失败，避免推断空间。真实 Native 快照续写测试覆盖消息生命周期、批量边界、跨团队拒绝和原库不变。默认生产消息写入仍保持 Native。

> P8 任务写入 canary：Main tasks DAO 已接入显式 TS 写入门禁，覆盖任务创建、更新、按 ID 删除和按会话批量删除；任务所属会话／空间由 TS 仓库校验，跨团队删除硬拒绝。真实 Native 快照续写测试覆盖数组／元数据字段和原库不变。默认生产任务路由仍保持 Native。

> P8 计划写入 canary：Main plans DAO 已接入显式 TS 写入门禁，覆盖计划创建、更新、删除及 JSON 规格投影；计划所属会话和工作空间由 TS 仓库再次校验，跨团队更新硬拒绝。真实 Native 快照续写测试确认删除不会修改 Native 源库。默认生产计划路由仍保持 Native。

> P8 项目写入 canary：Main projects DAO 已接入显式 TS 写入门禁，覆盖项目创建、更新、删除及默认／插件项目幂等确保；跨团队项目删除按空间硬拒绝。真实 Native 快照续写测试覆盖项目字段投影和原库不变。默认生产项目路由仍保持 Native，尚未宣告项目整域切换。

> P8 普通会话写入 canary：Main sessions DAO 已接入同一显式 TS 写入门禁，覆盖会话创建、更新、删除和整空间清理；请求未携带工作空间时拒绝启用，跨团队删除由 TS 仓库拒绝。真实 Native 快照续写测试确认 TS 清理不会修改 Native 源库。默认环境仍由 Native 写入，尚未扩大为默认生产路由。

> P8 Goal 写入 canary：Main Goal DAO 已接入与其他离线业务域一致的显式、可撤销 TS 写入门禁；在已验证 handover 副本提升后，创建、更新、用量计账、事件和清理均路由到同一 BusinessRepository，失败不会静默回退 Native，避免双写。Goal 与消息、项目、任务、计划、Cron、记忆、绘图、桌面流程及 QQ 唤醒等已纳入统一业务写入边界；默认生产所有权仍需通过显式 handover 入口完成，SSH 旧表保持回滚专用。

> P8 Goal 清理路由补齐：TS 仓库现在提供与 Native `goals-clear` 对齐的工作空间限定清理入口，保留 cleared 结果和 cleared 事件；真实目标交接测试已从旧的通用删除方法切换为该路由对照。生产 Goal IPC 仍未切换 TS 写入者。

> P8 插件／渠道会话同步写入：TS 交接仓库已补齐普通项目按空间读取、插件会话模型绑定同步、项目绑定同步和插件数据原子清理；托管 provider、model source 与项目均按请求空间校验，删除个人／团队插件数据不会触及另一空间。真实 Native 数据库与交接副本对照同步计数、模型投影、项目投影、删除消息数及跨空间残留通过；Main 渠道生产写入和路由仍由 Native 持有，尚未宣告渠道整域切换。

> P8 消息完整写入生命周期：TS 单写入仓库已补齐幂等单条／批量新增、局部更新、整会话替换、截断、清空、按角色删除末条及压缩产物插入，并把会话归属、消息 ID 归属和批量原子性限定在显式工作空间。读取列表前会与 Native 一样修复删除造成的排序空洞；消息正文、元数据和用量不再误受普通标识符的 1024 字符上限。真实 Native 数据库与交接副本逐步执行并对照完整生命周期，另验证跨空间批量请求不产生部分写入。生产 Main 的消息写路由仍由 Native 持有，因此尚未完成默认写入者切换。

> P8 默认／渠道项目确保操作：TS 单写入仓库现在在工作空间范围内选择现有项目、为缺少目录的本地默认项目分配唯一目录、或创建新默认／渠道项目；SSH 项目保持原样，重复调用幂等。目录基路径必须由宿主显式提供绝对路径，避免交接副本意外写入真实用户 Documents。真实 Native 数据库与交接副本在隔离目录中对照项目名称、目录后缀、空间归属与重复调用；生产 Main 仍由 Native 持有这些项目写入路由，完整接管及实际用户目录安全验收未完成。

> Electron 多窗口空间事件烟测扩展：现有真实 Electron IPC 测试补充团队 A／团队 B／团队 A 往返切换，核验事件只到达当前登记空间的窗口，重载后未登记窗口保持静默；子 frame 仍不得代主窗口登记。`npm run test:electron-ipc` 在本机 macOS 通过，CI 的 macOS 构建任务已有该入口。它尚不是完整应用页面、授权撤销、会话标签或六平台 UI 端到端验收。

> Main 动态 Worker 资产续查：桌面 TS 服务持有的 `out/storage/lease-worker.mjs` 现进入安装包解包清单并纳入资产门禁。TS 只读 Worker 在 Electron 开发模式改用稳定的源码路径，避免 electron-vite 重建清空 `out/main` 后金丝雀只读失效；正式包仍使用已复制的同级 Worker。资产门禁同时检查两条路径约定及打包清单。真实 macOS 安装包与其余平台启动仍需单独验证。

> Electron TS 只读 Worker 打包缺口修复：`LegacyReadRepository` 从 Main bundle 相对路径加载 `legacy-read-worker.mjs`，此前构建脚本只将其复制到 `out/runtime/`，导致桌面打包路径缺少该文件并可能持续回退 Native。现构建也复制到 `out/main/`，打包时解包，主进程资产验证显式检查存在性。构建和资产门禁通过；仍需六平台安装包启动与实际只读调用端到端验证。

> 渠道状态与用量生产只读切片：`/status`、`/stats` 在已授权空间内默认尝试 TS 只读 Worker，异常或 `OLA_TS_CHANNEL_SESSION_READS=0` 时回退 Native；`/compress` 仍由 Native 写入。真实 Native 数据库的会话状态、复合用量、异空间空结果与 TS 只读结果逐字段对照，Canary 测试覆盖默认开启及关闭。命令结果在发送前仍复核离线团队授权。此项不切换生产数据写入者或渠道 Agent 引擎。

> 离线团队渠道命令撤权复核：Main 的命令派发在执行前、处理完成后及发送结果前重查工作空间目录授权，避免路由时仍授权、命令期间撤权后继续发送状态／用量或确认回复。纯授权时序测试覆盖执行前拒绝、运行中撤权后抑制结果及个人离线可用。已发生的外部发送或命令副作用不能由此通用回滚，仍需真实渠道与桌面时序端到端验收。

> P8 渠道会话用量与压缩交接：TS 单写入仓库补上工作空间受限的用量聚合和历史消息压缩，按 Native 的账单输入／缓存／推理／时长／请求次数规则忽略损坏的旧 usage，且只压缩除最近六条外的旧消息。真实 Native Worker→交接副本逐字段比较个人／团队隔离、复合用量、工具结果与 thinking 清理的持久化内容；异空间压缩不读写消息。同组的状态查询已在前项完成。生产渠道命令仍调用 Native，故不能宣告整体 TS 接管或端到端渠道验收完成。

> 渠道会话命令空间隔离：`/status`、`/compress`、`/stats` 现将渠道已授权空间传给 Native；状态与用量查询限定空间，压缩先限定消息读取范围，并在每条更新 SQL 中复核空间。真实 Worker 测试覆盖异空间状态／用量不可见、旧工具结果不能被异空间压缩，以及同空间有效压缩。TS 单写入仓库已补齐会话状态查询并与真实 Native 交接副本逐字段对照；用量与压缩交接见上项。生产命令路由切换及桌面渠道撤权时序仍需端到端验收。

> P8 计划按会话读取与完整投影：TS 单写入仓库补上 Native 的“按会话取最近更新计划”入口，并统一列表、按 ID、按会话及写后返回的计划投影，包含来自会话归属的 `workspace_id`。真实 Native Worker→交接副本对照逐字段比较三种读取路径，团队异空间查询返回空。生产计划查询仍走 Native，不能视为计划整域接管。

> P8 渠道 `/new` 会话重置空间边界：渠道路由将已授权的工作空间传给命令处理器；Native 重置路由现在要求该空间确实拥有会话，删除消息与更新标题／计数的 SQL 再次限定空间。TS 单写入仓库提供对应原子操作。真实 Worker 与交接副本测试覆盖异空间拒绝、消息保留、同空间重置及重复重置。生产重置仍调用 Native，整域接管及撤权时序的桌面端到端验收未完成。

> P8 工作空间会话清空补齐：TS 单写入仓库现与 Native 一样，在同一事务内仅清空指定空间中 `plugin_id IS NULL` 的会话及消息，并返回被删除的会话 ID、消息数和会话数；插件会话与其他空间数据保留，重复清空返回零。交接副本专项测试覆盖边界。生产设置页仍调用 Native 清空路由，Main 路由切换与真实桌面验收未完成。

> P8 会话任务批量删除补齐：TS 单写入仓库现在支持按会话删除任务，先校验会话确属请求工作空间，再在 SQL 删除条件中保留空间约束；重复删除返回零，异空间请求不删除任何任务。交接副本测试覆盖这些边界，完整运行时回归 717 项通过。生产 Main 目前仍调用 Native 路由，不能据此视作任务整域接管。

> P8 Agent 变更日志保留期清理：TS 单写入仓库现与 Native 一样，在一个事务中仅删除 `updated_at < cutoff` 且状态为 `reverted` 的运行及其文件变更，保持未撤销和恰在边界上的记录；清理可重复执行。读取投影也对齐 Native 对空可选字段的省略形状。真实 Worker 与交接副本在个人／团队记录上的清理结果及剩余记录逐字段对照通过。Main 生产清理仍由 Native 路由执行，整域接管未完成。

> P8 子 Agent 旧历史导入标记交接：`app_migrations` 虽由 Native 建表，却承载 Renderer 防止重复导入子 Agent 历史的持久状态，现纳入交接前 schema 契约。TS 单写入仓库可读取既有标记并幂等写入新标记，保持 Native 缺失标记时省略 `appliedAt` 的序列化形状。真实 Worker→快照→TS 续写及重开对照通过；生产 Main 仍由 Native 持有该路由，未宣告整域接管。

> TS 交互审批撤权复核：调度器在提交待处理的工具／计划／问题响应前，按运行原工作空间重新执行授权，并在异步授权与持久化回复前后检查运行取消信号；团队离线授权撤销后，旧审批不会唤醒执行器。专项测试覆盖等待审批后撤权及授权检查中途撤权。真实账户目录时序和桌面审批 UI 仍需端到端联调。

> TS 桌面会话提交／空间切换时序门禁：Main 在核验窗口空间与持久化会话后、提交 TS Runtime 前持有提交准入；切换空间时先锁住新的 TS 提交，再检查 Native Agent、Cron、Desktop Flow 和 SSH 活动。提交等待会话查询或 Runtime 回执时，切换明确返回忙；切换等待 Runtime 回执时，旧空间新提交被拒绝。提交回执返回时再次核验窗口空间，若窗口已被其他路径改动则拒绝返回旧空间运行并请求取消。专项竞态测试覆盖这些顺序；正式会话全功能迁移及真实 Electron 多窗口联调仍未完成。

> P8 交接产物落盘门禁：SQLite 备份、只读回滚副本和 manifest 在宣布快照成功前分别执行文件同步，Unix 系统还同步备份目录，任一步失败均不提升 TS 写入副本并清理本轮未完成产物。隔离快照／恢复专项测试通过；仍需真实断电恢复与六平台文件系统验证。

> P8 备份容量预检：协调器在停写 Native 前依据数据库与 WAL 的当前体积，为备份、只读回滚副本和恢复演练按四份容量加 64 MiB 余量检查目标文件系统可用空间；创建快照时再次检查。容量不足时不进入停写。此检查不能保证其他进程不会在随后耗尽磁盘，也不替代实际快照与恢复验证。

> SSH 工作空间隔离修复：删除连接时先成功保存当前空间的配置，再只断开同空间、同连接 ID 的终端会话及其跳板连接；另一团队或个人空间即使使用相同连接 ID，也不会被误断开。专项选择测试覆盖个人／双团队重名 ID；真实 Electron 多窗口 SSH 端到端仍待验收。

> P8 SSH 交接清单修正：Native 数据库中的 `ssh_groups`／`ssh_connections` 是回滚保留表，当前 Main 的实际 SSH 配置使用按空间隔离的 JSON，不应将旧表升级为 TS 正式读写域。交接快照仍保留旧表字节，TS 业务 schema 与写入仓库不接管它们；团队 SSH 继续由现有空间机制管理。

> P8 交接备份目标预检：协调器在调用不可逆的 Native 停写回调前，先验证备份目录非链接且仅当前用户可访问，并完成独立写入／刷盘探针；目标为文件、权限过宽或符号链接时不触发停写。真正快照前会再次执行同一校验，拒绝停写期间被替换的目录。隔离数据库专项测试覆盖预检失败不停车及两阶段替换拒绝。这不证明磁盘容量充足，也不代表桌面生产切换已接线。

> 隔离桌面测试的外部资料路径补充：浏览器 Profile 自动探测在 `OLA_E2E_DATA_ROOT` 下只使用已验证的模拟 home，Windows 不再沿用宿主 `LOCALAPPDATA`，并拒绝资料根或 Profile 经符号链接逃出测试根；OpenCode 导入默认配置也改从模拟 home 读取，Main 暴露给 Renderer 的 `app:homedir` 同步返回模拟 home。OpenCode 配置／instruction 真实路径、绝对路径、`../`、glob 和文件符号链接在测试模式下不能逃出模拟 home，环境模板只可读取 `OLA_E2E_` 前缀变量，避免把宿主秘密带入预览。临时目录测试覆盖这些分支。其他用户显式选择的外部路径仍未全量隔离，完整 Electron E2E 仍不能放行。

> Agent 工具结果恢复只读切片：Main 在核验会话持久化空间与离线团队授权后，默认从当前 Native 数据库经 TS 只读 Worker 查找历史工具结果（`OLA_TS_TOOL_RESULT_READS=0` 可关闭），失败回退 Native；返回前再次核验会话归属和团队授权，拒绝撤权后的迟到结果。真实 Worker 数据库对照覆盖个人／不同团队隔离、去重与 256 项上限、完成时间排序、JSON 内容及可选开始时间的序列化形状，Main 路由专项测试覆盖回退与撤权竞态。结果持久化与运行执行仍由 Native 持有，不能据此判定 Agent 已由 TS 接管。

> 子 Agent 历史只读切片：Main 的索引与分页列表在核验会话所属工作空间及离线团队授权后，默认从当前 Native 数据库经 TS 只读 Worker 读取（`OLA_TS_SUB_AGENT_HISTORY_READS=0` 可关闭），异常时回退 Native。真实 Native Worker 数据库的个人／团队隔离、排序、分页、快照字段及关闭开关已逐字段对照。历史写入、替换及迁移标记仍由 Native 持有；这不代表子 Agent 整域或生产数据所有权已切换。

> 记忆流水线只读切片：Main 的记忆根、任务、自动记忆记录按 ID／列表及 Stage1 有效输出列表，在显式空间下默认尝试 TS 只读 Worker（`OLA_TS_MEMORY_ROOT_READS=0` 可关闭），按 Native 的字段形状、过滤及排序从现有数据库读取，异常回退 Native；旧内部未显式携带空间的列表仍走 Native。真实 Worker 个人／团队归属、自动记忆记录内容快照遮蔽、全字段、过滤和跨空间拒绝对照通过。记忆相关 MessagePack IPC 现统一要求可信主窗口、窗口登记空间与请求空间一致及离线团队授权，并在异步结果返回前复核；专项测试覆盖窗口切换和团队授权撤销后的结果拒绝。记忆任务、Stage1、自动记忆记录的写入及生产数据所有权仍由 Native 持有，完整 Electron 多窗口验收尚待完成。

> 自动记忆面板切换保护：面板的记录、根与任务作为同一组请求结果提交，只接受当前工作空间／项目上下文中的最新请求；空间、项目或 SSH 上下文切换会立即遮蔽旧数据，A→B→A 往返也不能复用旧结果，旧请求失败不会在新空间弹错。该逻辑有专项竞态测试和类型检查；真实 Electron 多窗口与完整视觉验收仍待完成。

> 生成图片空间目录：Main 图片持久化与 GIF 九宫格输出现在要求显式请求空间与可信主窗口登记空间一致，并复核离线团队授权；个人空间新文件写入统一 Ola 数据根的 `generated-images`，团队空间写入各自哈希目录下的同名目录。历史 `~/ola/image` 文件不迁移、不删除，已有运行记录中的绝对路径仍可读取；团队 GIF 若同时提供内联数据会优先用数据，避免对旧共用图片路径的读取。新输出拒绝目录符号链接、跨空间 GIF 文件来源及带路径分隔符的运行 ID。专项路径／授权测试通过。其他用户目录入口尚未全部隔离，因此不能仅凭此项放行全应用 Electron E2E；已有图片的跨设备同步也未实现。

> 工作台会话标签起步：主工作区现提供按逻辑窗口与个人／团队空间分别持久化的会话标签，可从近期打开的会话切换、关闭后转至邻近标签或首页，并支持方向键操作；它只显示当前空间仍存在的会话，损坏的持久化标签会被裁剪。空间切换后，窗口重新登记成功才加载目标空间项目／会话，旧空间或较早的异步列表不能覆盖新结果；成功加载后清理已删除标签。纯状态与竞态测试通过，真实 Electron 多窗口、视觉和完整标签／分屏工作台验收仍待完成。

> Desktop Flow 运行历史只读切片：Main 在现有窗口空间授权后默认经 TS 只读 Worker 查询 Native 数据库，`OLA_TS_DESKTOP_FLOW_RUN_READS=0` 可关闭，失败回退 Native；定义列表原有只读切片保持不变。真实 Native 数据库的个人／团队空间过滤、字段、限制与关闭开关对照通过。录制、回放、写入及生产所有权仍未转向 TS。

> Draw 运行列表只读切片：Main 经离线空间授权后默认尝试由 TS 只读 Worker 从当前 Native 数据库读取，`OLA_TS_DRAW_RUN_READS=0` 可关闭，异常时回退 Native。真实 Worker 数据库的个人／团队空间隔离、排序与完整字段对照通过。Draw 保存／删除及生产数据所有权仍由 Native 负责，未完成整域 TS 接管。

> 隔离数据库的项目目录安全默认值：Native 项目创建、默认／插件项目及更新补目录在请求显式指定 `dbPath` 且未给出 `baseDirectory` 时，会将目录分配到该数据库旁的 `projects/`，避免测试或交接演练误写真实 `~/Documents`；显式用户基目录及正式桌面的 Main 设置仍优先。真实 Worker 的隔离临时目录测试覆盖各分支。此项不构成整个应用可安全覆盖数据根的证明。

> 个人记忆路径解析收紧：Renderer 在 `app:global-memory-home` 不可用时不再根据 `app:homedir` 或环境变量猜测 `~/.ola`；团队空间原有的 Main 授权路径要求保持不变。这样 Main 数据根隔离或故障时不会误读真实个人记忆目录；专项测试覆盖个人路径失败与团队拒绝。Main 仍需继续完成其余数据路径隔离。

> 宠物资源路径归并：Renderer 皮肤扫描和宠物记忆不再用 `app:homedir` 自行拼接 `~/.ola/pets`，改经窄口径 `pet:data-dir` 从 Main 获取与 Main 宠物写入相同的统一数据根目录。契约测试覆盖 Renderer 请求与 Main 注册；其他用户目录入口尚需继续清点，完整隔离 E2E 未放行。

> Wiki 数据根防护补齐：项目扫描与 Markdown 导出不再各自硬编码 `~/.ola`，而是使用 Main 的统一 Ola 数据根；存在符号链接、macOS 路径别名或尚未创建的子目录时，仍按真实路径阻止读写数据根。隔离临时目录测试覆盖这些情况。该修复为未来隔离桌面 E2E 的前置条件之一，不表示整个应用的数据路径已可安全覆盖。

> Cron Native 运行快照的托管模型与提供商空间校验已补齐，与 TS 交接写入的约束一致；真实 Worker 测试覆盖跨团队拒绝和同空间成功。该约束只保护当前写入边界，不能替代生产 Cron 调度切换或全桌面验收。

> Cron 运行快照空间归属补齐：Native 和 TS 在写入运行快照时，若来源会话／项目 ID 仍存在，必须属于任务工作空间；已删除来源的历史 ID 保持快照兼容。真实 Worker 与交接副本测试覆盖跨团队来源拒绝，同空间来源保持可写。生产调度与整体 TS 接管仍待完成。

> Cron TS 交接写入边界补齐：任务创建／更新及运行快照现在与 Native 一样拒绝引用其他工作空间的 `ola-managed:` 来源提供商；交接副本测试覆盖三条路径。Main 创建 Native Cron 定义时也显式传递已验证的空间，Worker 拒绝请求空间与任务归属不一致。此处只证明写入契约对齐，生产 Cron 写入仍由 Native 持有。

> Cron Native 过渡安全边界：创建和更新定义现于同一 SQLite 写事务内验证请求空间与来源会话／项目一致，且公开托管模型绑定及 `ola-managed:` 来源提供商不得指向另一空间；更新不可通过伪造行的空间改变既有任务归属。Native Agent 的 Cron 创建、列表、更新与删除工具要求显式运行空间并按该空间查询／修改，避免跨团队任务泄露或误删。真实 Worker 对跨空间会话、项目、模型、提供商及更新伪造的拒绝测试通过。旧引擎仍为生产写入者，需继续完成 TS 接管和桌面端到端验证。

> Cron P8 接管契约补齐：TS 单写入仓库的任务定义列表未显式分页时不再截断为 200 条；显式分页仍有限额。运行详情现在包含所属任务，消息和日志投影与 Native 逐字段对齐。206 条任务的交接副本回归、同一真实 Native 数据库的运行详情全字段对照通过。定时器、执行中任务、渠道 inbox 与其余业务入口尚未整体转向 TS，不能据此提升生产所有权。

> P8 会话／项目模型来源写入校验：TS 交接仓库的创建和更新入口现在仅接受合法本地来源或归属于请求空间的托管来源，空字符串归一为空值；跨团队来源、额外字段和控制字符被拒绝，更新失败不覆盖既有绑定。会话 `ola-managed:<workspace>` Provider ID 也在 Native 与 TS 创建／更新时按空间校验，Native 渠道会话创建、路由、模型同步及 TS 渠道会话创建／路由同样拒绝跨空间 Provider。TS 新会话在同时提供 Provider 与 Model ID 且未显式选择模式时，现与 Native 一样默认为 `manual`，否则为 `inherit`；创建入口的空白可选模型 ID 也按 Native 归一为空。新会话关联同空间项目时，未显式提供的工作目录和 SSH 连接分别继承项目值；显式字段保留优先级。真实 Native Worker 与其数据库交接副本上的 TS 续写已有专项回归。生产路由仍由 Native 持有，不能据此宣布接管。

> 会话关联计划归属补齐：Native 与 TS 会话创建／更新在写入已有 `plan_id` 前检查该计划确属目标会话，防止个人／团队或同团队不同会话之间挂错计划；尚不存在的预分配 ID 仍保持旧流程兼容。真实 Native Worker 和交接副本测试覆盖现存异会话拒绝、原会话允许关联。完整迁移和生产切换仍待完成。

> 任务关联计划归属补齐：Native 任务创建现于同一数据库事务内确认计划属于任务的会话；TS 交接仓库原有创建校验保持，新增更新 `planId` 时的同会话校验，失败不改变原任务。真实 Worker 与交接副本测试覆盖同团队异会话、跨团队拒绝及同会话成功。Native 任务更新尚不支持改变 `planId`，本轮未扩展该旧接口。

> Cron 运行历史只读切片：Main 的运行列表、单项读取与详情现默认按显式工作空间尝试 TS 只读 Worker（`OLA_TS_CRON_RUN_READS=0` 可关闭），失败或旧内部无空间请求回退 Native；详情包含原任务、按序消息及日志。真实 Native 数据库的空间过滤、时间／任务筛选、单项与详情字段对照通过，生产写入、任务执行与历史归属仍由 Native 负责。此切片未完成 Cron 整域 TS 写入接管或 Electron 多窗口端到端验收。

> Cron 多窗口事件隔离补充：定时／手动触发、运行开始、进度、日志、结束以及自动删除通知不再广播到所有窗口或随意选取首个窗口，而是只投递给登记在任务工作空间的窗口；事件均携带工作空间 ID，Renderer 在处理前核验活动空间，切换时清空待刷新的日志缓冲。Native 与 TS 后台执行器的完成快照读取也按原任务空间限定。专项测试覆盖事件路由参数与旧空间事件拒绝；真实 Electron 多窗口和撤权时序端到端仍待验证。

> Cron 定义只读切片：Main 的任务定义列表与单项读取默认尝试从 Native 当前数据库经 TS 只读 Worker 获取（`OLA_TS_CRON_JOB_READS=0` 可回退），仅限显式工作空间，失败时仍回退 Native。真实 Native 数据库的跨空间、软删除与字段结果已有专项对照。Cron MessagePack IPC 现要求已登记的可信主窗口、显式工作空间与离线团队授权，读取返回前复核，避免无空间列表退化为跨空间查询或撤权后的迟到结果；渲染侧调用已补齐空间 ID，首次加载等待窗口登记，切换空间清空缓存并丢弃迟到结果。运行记录的 IPC 修改在 Main 和 Native 写入事务中校验空间，跨空间请求专项测试通过。运行历史、写入、调度和生产数据所有权仍由 Native 负责，尚未完成整域迁移或 Electron 端到端验收。

> 数据根隔离准备：Main 的数据库目录查询、配置／设置、MCP／渠道与 QQ 会话、团队运行时、远程连接、用户内容目录、输入草稿、宠物、扩展、Wiki、CodeGraph、同步文件及迁移备份／预览／应用现共用 `olaDataRoot()`；Hook、Soul、全局记忆及团队 SSH 配置的路径契约也可明确传入 Ola 数据根，Main 调用处已使用统一根。Native Worker 的数据库、配置／设置、MCP／渠道与 QQ 会话、同步、扩展、用户内容、自动记忆、图片及团队运行时默认 `~/.ola` 入口现共用 `OlaDataRoot.DirectoryPath`。默认路径仍是 `~/.ola`；仅显式设置 `OLA_E2E_DATA_ROOT` 为已存在的绝对目录、且目录内 `.ola-e2e-root` 内容严格为 `OLA_ISOLATED_E2E_ROOT\n` 时，两侧才使用该测试目录。错误覆盖会直接报错，不会回落真实用户数据。真实 Worker 默认数据库对照测试已覆盖此契约。Renderer 和其他系统主目录入口仍待清点／归并；这个覆盖只隔离已归并入口，不能当作完整应用 E2E 安全许可。

> 测试数据根外部目录补充：个人 SSH 配置与 Main／Native 技能目录在隔离测试模式下现使用已验证的数据根作为模拟 home，正常运行仍分别沿用 `~/.ola.json` 与 `~/.agents/skills`；Native Agent 的 Skill 工具也指向同一测试技能目录。项目默认目录在测试模式下强制归入 `<测试根>/projects`，Main 不再采用旧设置中的自定义／最近目录，Native 即使收到显式 `baseDirectory` 也只在测试根内分配；正常运行保留原有目录选择。Main 与 Native Shell／Terminal 的默认工作目录也改用模拟 home，子进程 `HOME`、`USERPROFILE`、`XDG_CONFIG_HOME` 在测试模式下指向测试根，且 Main 不启动 macOS 用户 shell 环境探测。SSH 的默认 OpenSSH config、known_hosts 与 `~` 密钥路径解析也使用模拟 home；真实 Worker 对照覆盖其默认读取。Electron 在启动早期将 `userData` 指向 `<测试根>/electron-user-data`，无标记覆盖在设置路径前失败；默认数据库、个人 SSH、技能解析、项目创建和 Shell／Terminal 路径也有真实 Worker 测试。显式外部路径及其他进程环境入口尚未全量隔离，不能据此启动完整 Electron E2E。

> 2026-09-19 空间切换竞态补充：Main 在异步 TS `workspace.switch` 返回后再次核对发起窗口仍登记在原空间，Renderer 在最终提交本地空间前再次核对原空间与目标目录授权。Main 切换期间暂时关闭 Native Agent、Cron 新运行接单、桌面流程录制／回放以及 Main SSH IPC 请求；已有相应活动、在途 SSH 请求或另一切换在途则拒绝，成功或失败后释放门禁。SSH 包装层从授权开始到处理结束计数，覆盖连接、SFTP 与传输启动的异步空隙；已启动的后台任务仍由原活动表拦截。Cron 定时触发和手动触发在门禁期间均不写入新的 skipped 记录。回归测试覆盖请求期间窗口改属、团队目标撤权、并发切换，以及 Agent、Cron、桌面流程和 SSH 接单时序。其他不经这些入口的活动域仍待清点；这不等于完整全局原子租约。正式 Main 和 Native Worker 仍有多处直接使用用户 `~/.ola`；仅覆盖 Electron `userData` 无法隔离全应用测试，完整桌面端到端须先完成所有数据路径隔离。

> Goal 运行态空间归属补充：Main 验证后的工作空间 ID 现贯穿 Goal 准备、用量累计、状态更新和事件追加；Native Goal 路由在请求显式携带空间时，使用持久化会话归属再次核验，跨空间读写均拒绝且不改变目标或事件。未携带空间的旧 Worker 内部调用暂保留兼容，不能视为完成生产所有权切换。真实 Native Worker 跨空间读取、创建、替换、更新、清除、计费和事件专项测试通过；完整桌面端到端仍待验收。

> P8 消息排序交接补充：在旧写入者停下并完成不可变回退基线后，TS 交接协调器现在对提升的数据库副本显式修复历史消息 `sort_order` 异常，沿用 Native 的创建时间、角色、原序号优先级；修复在单个事务中完成，重复执行无变化。修复后再次核验旧库未变化，旧写入者迟到写入会拒绝提升并关闭 TS 仓库。测试证明个人与团队会话的异常得到修复，原库与回退基线保持原样，修复后仍可从基线恢复。正式桌面切换及大库性能验收仍待完成。

> 多窗口空间切换门禁补充：Renderer 在 TS 服务不可用时仍调用 Main 的活动查询，Main 按已登记窗口空间验证来源，并检查 Native Agent 的提交中／活动运行、Cron 活动／收尾运行及全窗口 SSH 活动；有活动时拒绝切换。TS 服务可用时，最终 `workspace.switch` IPC 也重复检查，避免仅依赖 Renderer 缓存。同一 Renderer 的并发切换现在只允许一个在途操作，异步预检后再次确认目标仍在账户目录，失败后可重试。专项测试覆盖伪造来源、三个活动域、双切换交错及预检期间撤权；窗口活动与新任务并发进入之间尚缺原子租约，真实 Electron 多窗口竞态仍待验收。

> 窗口空间登记来源补充：Main 的 `window:workspace:set` 和渠道任务确认入口现在要求 IPC 发送者正是目标 BrowserWindow 的 WebContents 主 frame；guest、子 frame 或不存在的窗口不能修改主窗口空间登记，也不能确认其渠道任务。已有版本号门禁继续拒绝乱序的旧授权完成；专项测试覆盖主 frame、子 frame 和 guest 来源。真实 Electron guest 联动仍待验收。

> Electron IPC 烟雾验证补充：`npm run test:electron-ipc` 以临时 `userData` 启动真正的 Electron 隐藏窗口，在主 frame 登记本地空间后由真实 iframe 尝试改为团队空间，确认 Main 拒绝子 frame 且原登记不变；第二个窗口登记团队空间后，真实 MessagePack 广播只到该窗口。首窗口切入团队后两个窗口均接收；第二窗口重载使登记失效后不再接收。macOS 构建流水线执行此门禁。该测试不启动 Ola 正式 Main，也不读取用户 `~/.ola`；它验证 IPC 与窗口路由，不替代完整个人／团队 UI 和 guest 端到端验收。

> Agent 运行入口空间门禁补充：Main 现在先从持久化会话解析工作空间并核验离线团队授权，再调用 Goal 运行时准备消息；准备完成后再次核验会话归属与授权。若授权撤销或后续 SSH 参数准备失败，未获 Agent 接纳的 Goal 运行态会被丢弃，排队的延续提示恢复待下次使用，并发送运行结束状态。Goal 准备阶段的读取已携带核验后的空间；生产 Goal 写入仍由 Native 持有。专项测试覆盖伪造空间、撤权、本地个人离线及准备态清理。

> Goal 桌面空间边界补充：Renderer 的 Goal 列表、详情、事件和变更请求现携带活动空间；Main 要求显式空间、离线团队授权及持久化会话归属，Native 列表查询以会话的 `workspace_id` 在 SQLite 内过滤，团队读取返回前再次核验授权。切换空间时清空 Goal／事件／运行态缓存，迟到响应不再回填；Goal 同步事件只投递到同空间的已登记窗口，Renderer 仍核验事件中的空间 ID。Goal 列表、详情与事件的生产读取现默认尝试只读 TS Worker（可用 `OLA_TS_GOAL_READS=0` 关闭），异常回退 Native；内部未带显式空间的 Goal 运行时读取继续走 Native。真实 Native 数据库的个人／团队 Goal 与事件已做 TS 对照，`db-ipc-message-scope`、`window-workspace-routing` 及 `legacy-read-canary` 回归覆盖无空间拒绝、跨空间过滤、多窗口投递和开关；本轮运行时测试为 169 文件、617 项通过。Goal 写入所有权仍在 Native，真实 Electron 多窗口与切换竞态端到端验收尚待完成。

> Goal 交接写入语义补充：TS 交接仓库清除目标时现在保留历史事件并追加 `cleared` 事件，不再删除会话的 Goal 审计轨迹；清除后仍可按已持久化的会话空间读取并追加事件（未指定目标 ID 时为 `null`）。事件列表按新到旧排序，旧空间无法读取或变更另一空间的事件。真实交接副本测试覆盖清除前后历史保留和后续追加。其余写入语义见下文；这仍不代表 Goal 可以切换生产写入所有权。

> Goal 用量交接补充：TS 交接仓库现可在单个事务中按持久化会话空间与可选预期 Goal ID 累加时间、Token，按 Native 的阈值规则将活动／暂停目标转为 `budget_limited`，并记录 `usage_accounted` 与首次越界的 `budget_limited` 事件；过期目标 ID 不写入，无增量不产生日志，负增量按 Native 规则归零。交接副本测试覆盖这些状态和跨空间拒绝。生产交接仍待完成。

> Goal 创建／替换交接补充：TS 交接仓库现按持久化会话空间在事务中创建或替换目标；重复创建不会覆盖旧目标，也不会新增事件，替换会生成新目标 ID、将 Token／时间计数归零、重设起始时间，同时保留原事件并追加 `replaced`。新建追加 `created`；预算必须为正，状态使用 Native 允许集合，跨空间会话拒绝写入。真实交接副本测试覆盖这些边界。生产写入切换仍未完成。

> Goal 更新交接补充：TS 交接仓库现在按 Native 的两条更新分支处理目标变化。目标文本实质变化会生成新 Goal ID、重置用量与创建时间，并将已完成／受限／阻塞状态恢复为活动状态（除非明确指定状态）；预算或状态变更而目标不变时保留目标代次和用量。事务内依次记录 `objective_updated`、`budget_updated` 及相应状态事件，预算阈值仍可把活动／暂停状态归一为 `budget_limited`。交接副本测试覆盖预算限制后改目标、改预算和状态、再次触发预算限制、解除预算及跨空间拒绝。生产写入切换仍待完成。

> Goal 真实 Native 对照补充：同一份 Native Worker 创建的会话数据库快照分成 Native 原库与 TS 交接副本，分别执行 Goal 创建、用量累计至预算限制、改目标、改预算和状态、替换及清除；每步 Goal 行逐字段一致，事件按目标 ID、类型、消息和元数据比较一致，随机事件 ID 与毫秒时间戳不作为等值条件。跨空间读取为空；本轮运行时测试为 170 文件、621 项通过。此证明了这条序列的行为，不覆盖所有异常／并发路径，也不代表生产写入所有权已切换。

> Goal 异常与事件边界补充：TS 交接仓库对已无目标但会话仍存在的重复清除返回 `false` 且不再追加事件；跨空间会话仍拒绝。事件列表现可按可选 Goal ID 过滤，默认上限 40，显式上限按 Native 规则收敛到 1–100。显式事件追加在未指定 Goal ID 时保留 `null`，空元数据对象也按 Native 归一为 `null`，不再借用当前目标 ID。真实 Native 与 TS 同数据序列已对照事件内容、过滤和重复清除；生产交接及更广的并发故障验证仍待完成。

> Goal 大列表补充：Native 默认目标列表不分页，TS 交接仓库原先隐式使用 200 条分页默认值，现仅在明确指定 `limit`／`offset` 时分页。真实 Native Worker 创建 205 个同团队目标并加一个异团队目标后的备份测试确认 TS 默认列表完整返回 205 条且不混入异团队，显式分页仍按参数返回；本轮运行时测试为 171 文件、622 项通过。这只验证列表边界，不代表桌面端大数据性能已验收。

> Goal IPC 撤权竞态补充：Main 的会话归属门禁现在在异步会话查询后再次核验团队离线目录；Goal 创建、替换、更新、清除在读取旧目标后和 Native 写入返回后也复核，累计与追加事件在写入返回后复核。目录在查询期间撤权会阻止写入开始；已进入 Native 写入的请求无法因此回滚，但撤权后的数据结果不会返回 Renderer，也不会再由该 IPC 触发 Goal 运行时处理。专项 IPC 测试覆盖查会话与查旧目标时撤权；本轮运行时测试为 171 文件、624 项通过。写入中撤权、恢复及重试的一致性仍需更强的事务／接管门禁。

> 2026-09-18 追加进度：下文数据表清点中的 11 张为此前统计；自动记忆 6 张、用量域 4 张、绘图历史 1 张、代码变更日志 2 张、子 Agent 历史 1 张、运行工具结果 1 张、运行任务与事件 2 张、Project Wiki 4 张、桌面流程 3 张及 QQ 唤醒窗口 v2 表已加入 TS 交接字段契约，当前按契约键实际清点为 37 张。TS 副本可按空间读写绘图、子 Agent 历史、工具结果、运行任务及事件、Project Wiki，读取用量明细及活动汇总；记忆域可按 Native 兼容的根归属键幂等创建记忆根、按指纹幂等写入 Stage1 产物、创建／结束记忆任务，以及写入／撤销自动化记录、记录引用并增加 Stage1 使用计数、标记空间限定 rollup 水位、按空间清理根的 Stage1 产物与可选任务。QQ 唤醒窗口使用带空间主键的新表，旧记录只回填本地个人空间，Main 在读写前核验离线团队授权；网关收到私聊消息时先保存原始消息 ID 与时间，只接受比当前来源更新的消息，避免重放使窗口倒退。真实 Native 备份后的 TS 来源更新、读写与同一 QQ 身份跨空间隔离测试通过。跨空间关联拒绝、默认列表遮蔽内容快照和真实 Native 备份后继续写入的测试通过。生产路由切换及完整端到端验证仍未完成。旧版无空间键的 rollup 表只保留在备份中，不作为空间限定读取入口。

> Native 表覆盖清点：当前 schema 声明 48 张表，交接契约覆盖 37 张；剩余 11 张在 `native-business-table-coverage` 测试中逐项登记为保留的旧版或技术表，并继续随 SQLite 备份保存。清单门禁会在新增 Native 表未分类时失败；它不证明旧路由已退役，也不代表所有活跃功能都已由 TS 接管。

> QQ 唤醒只读金丝雀：Main 现默认用 TS 只读 Worker 从当前 Native 数据库按空间计算唤醒资格（`OLA_TS_QQ_WAKEUP_READS=0` 可关闭）；读取失败回退 Native。团队授权在异步读取前后均复核，撤权后的迟到结果不返回。真实 Native 数据库的个人／团队同身份结果、未来时间、日／三日／七日／三十日边界、过期与已发送窗口均与 TS 只读结果对照通过；来源写入和已发送标记仍由 Native 独占，真实 QQ 网关端到端仍未验证。

> 用量隔离追加：Native `usage_events` 已有 `workspace_id`，写入按持久化会话／项目归属推导并拒绝伪造空间；明细、原始统计和删除按空间过滤。每日活动汇总使用带空间键的 v2 表，保留删除明细后的汇总行为；定期清理只在补齐对应空间的 v2 汇总后删除旧明细。旧无空间事件在迁移时按可用会话／项目归属回填，v2 从保留的明细重建。此前已清理明细、只剩无空间汇总的历史数据无法安全分拆到个人／团队，旧表保留但不作为新空间统计源。Renderer 统计页传递当前空间，Main 对团队空间使用离线授权目录校验。TS 交接副本现验证用量域四张表，并提供空间限定读取、来源归属校验、事务化写入和汇总、按空间删除明细及定期维护；真实 Native Worker 备份后继续写入测试通过。原始统计和活动汇总共 9 种查询已用同一份 Native 数据备份作结果对照；现增加提供商、模型、来源、包含边界日期、空范围、组合条件和跨空间筛选，以及明细分页对照，并要求 Native 已提供的核心统计字段在 TS 结果中均存在且相等。生产 Main 的用量明细列表及九类统计查询现默认从仍由 Native 写入的数据库走 TS 只读金丝雀（分别可用 `OLA_TS_USAGE_EVENT_READS=0`、`OLA_TS_USAGE_ANALYTICS_READS=0` 关闭），失败回退 Native；真实 Native 在线写入后的字段、筛选、分页与团队离线授权拒绝测试通过。TS 和 Native 读取均在返回结果前再次核验离线团队授权，撤销发生在查询期间时不向 Renderer 返回数据。真实 Native／TS 对照已在上海及洛杉矶时区通过；大数据性能与 Electron UI 端到端验证仍待完成，生产写入仍由 Native 独占。

> 用量只读金丝雀补充：五类原始统计和四类活动汇总查询现在均可在上述显式开关下由 TS 读取，并保持 Native 对 `null` 字段的省略形状；真实 Native 在线数据库上的九类结果、按小时桶、提供商筛选、活动模型／提供商分页、个人／团队明细隔离和 Main 路由已做专项对照。写入、删除与维护仍由 Native 处理；这不是默认路由或业务库写入所有权切换。

> TS 桌面运行时空间授权补充：运行时主机对本地数据的空间列表现使用账户绑定的离线授权目录，使已缓存授权的团队空间在网络不可用时仍可读取本地运行历史；未授权空间继续拒绝。托管模型资源与票据仍要求在线授权，不因本地目录缓存而离线放行。隔离目录下的真实运行时请求测试覆盖离线团队读取与未授权拒绝；完整本地模型执行和桌面 UI 离线端到端尚待验证。

> 绘图空间隔离追加：Native `draw_runs` 新增 `workspace_id`，旧历史记录迁到本地个人空间；列表、保存、删除、清空均限定空间，跨空间同 ID 更新被拒绝。Main 每次按离线授权目录校验团队空间，Renderer 绘图历史及持久化写入携带空间，切换工作空间时清理绘图内存态且运行中的绘图阻止切换。TS 交接副本也验证并读写这张表；真实 Native 隔离与备份测试通过。完整 Electron 绘图／切换端到端验证仍待完成。

> 子 Agent 历史隔离追加：Main 从持久化会话读取空间归属并以离线授权目录校验，Native 在索引、分页快照、写入和整会话替换前再次确认会话属于请求空间。TS 交接副本的相同四类操作也由会话归属约束；真实 Worker 拒绝跨空间快照读取／替换以及 Native 备份后的 TS 读取测试通过。历史数据迁移标记仍为全局一次性机制，桌面多空间迁移流程需进一步验收。

> 运行工具结果追加：Native 持久化前要求来源会话存在，查询时以持久化会话归属核验请求空间；Main 先验证离线团队授权。TS 交接副本新增按会话／空间限定的结果写入与查询，真实 Native 备份和跨空间拒绝测试通过。运行任务现在从持久化会话推导空间归属，同空间限定幂等键、查询、状态变更、取消及事件回放；旧任务按会话回填，无法确认归属的记录保留在本地个人空间。团队任务要求已有会话，Main 对查询入口校验离线授权。Native 隔离及旧库回填测试通过；TS 仓库现可接续 Native 备份中的任务，按空间提交、查询、更新状态、取消、写入与回放事件，生产接管仍待实现。

> 代码变更日志空间边界追加：Renderer 的会话列表、完整 diff 与撤销请求现携带活动空间，Main 核对离线团队授权、持久化会话及每条文件变更关联的会话归属；写入时也拒绝跨空间复用既有运行 ID。切换空间会清空变更日志缓存，异步旧响应不能重新填入新空间。Native `agent_change_sets` 已增加归属列，并按持久化会话回填旧数据；Worker 的读取、追加、状态变更、hydrated diff 和本地回滚入口均校验空间，跨空间复用运行 ID 被拒绝，旧数据中关联会话归属不一致的记录隔离为 `legacy-ambiguous`。TS 交接契约现要求 `agent_change_sets`／`agent_file_changes`，隔离副本仓库具备按空间读取、追加、撤销标记和运行状态重算。生产 Main 的读取现默认使用只读 TS canary（`OLA_TS_AGENT_CHANGE_READS=0` 可关闭），故障回退 Native；会话列表与完整 diff 在返回前再次核验离线团队授权，写入仍由 Native 独占。`native-agent-change-workspace` 与 `native-agent-change-handover` 测试覆盖 Worker 隔离、真实 Native 读取对照和数据库备份后的 TS 续写。桌面端端到端验证及生产写入接管仍未完成，不能视为该域完成迁移。

> 工作空间切换的 SSH 活动态门禁：Renderer 现在阻止在终端连接／重连、SFTP 连接、上传或可恢复传输活动时切换；Main 额外汇总所有窗口的终端会话、上传／传输任务和正在建立／已连接的 SFTP 状态，供切换前查询，并在 TS Runtime 切换入口再次拒绝活动任务。SFTP 登记在断开、配置删除和窗口关闭后清理；并发连接与迟到回调有独立回归测试。配置路径及主要调用链现按空间限定，但登出清理、所有后台入口与真实 Electron 多窗口端到端尚待验收。

> SSH 配置迁移切片：Main 的缓存初始化和轮询已改为 TS 直接读取 `ssh` 节点；本地个人空间保留 `~/.ola.json`，托管个人／团队空间使用 `~/.ola/workspaces/<sha256(workspace_id)>/ssh.json`，缓存也按空间隔离。SSH IPC、终端会话与诊断、Git SSH 调用按请求空间及离线目录授权约束，工作空间切换或账户目录变化会清空 Renderer 的 SSH 缓存；Agent 与 Cron 的 SSH 凭据解析要求持久化空间归属与离线授权。账户登出、令牌/API 地址切换或目录刷新撤销成员资格时，Main 现在按失效空间强制关闭终端会话、请求中止上传／传输、清除 SFTP 登记与诊断及含密码的配置内存缓存，并在迟到连接完成时再次核验授权；并发加载不得重新填入已撤销缓存，已排队或正在准备提交的配置 CRUD／导入写入在撤销后不得替换配置文件，单项关闭失败不跳过其余资源清理。Native 中止失败会保留任务登记供再次核查，本地个人 SSH 活动不随远程账户变化而终止。常规分组／连接 CRUD 与整份 SSH 快照写入由 Main TS 在串行队列中原子更新，保留文件其他根节点，使用私有权限，并拒绝损坏文件、符号链接及写前检测到的外部修改。SSH 导出及 Ola／OpenSSH 两种导入预览与应用均由 TS 处理；OpenSSH 替换连接时保留本地密码／启动配置。旧 Worker 的 SSH 配置／导入写入口尚未移除；团队 SSH 真正端到端与多平台验证仍待完成，不能视为 SSH 域完全验收。

> 渠道会话隔离追加：Renderer 的会话 IPC 请求携带当前空间，Main 对托管空间使用离线授权目录，并要求按插件 ID 查询时插件归属与请求空间一致；旧 Worker 的渠道会话列表、按聊天查找、消息读取、创建、清空、重命名、删除及插件数据清理均按 `workspace_id` 限定，跨空间删除和清空不会触及其他空间记录。Agent 的“读取当前渠道聊天消息”工具也以运行请求的空间限定查询。切换空间时渠道会话缓存清空，迟到的旧请求结果不再回填。真实 Worker 数据库回归覆盖同插件 ID 跨空间查询、消息与 mutation 隔离及团队创建。TS 交接副本已具备对应的渠道会话列表、按聊天查找、消息读取、创建、重命名、清空、删除及按插件清理能力；真实 Native 备份上验证跨空间隔离与后续写入不影响原库，并补上通用会话创建的跨空间项目拒绝、消息 ID 不可跨会话覆盖。生产 Main 的渠道会话列表、全列表、按聊天查找和消息读取现默认走只读 TS 金丝雀（`OLA_TS_CHANNEL_SESSION_READS=0` 可关闭），读取异常回退 Native；同一 Native 数据库的字段、消息和空间边界对照已通过。Main 在读取完成后再次核验离线团队授权，撤销期间的结果不会返回；写入所有权仍在 Native。

> 渠道新消息路由追加：Main 收到入站消息时现要求插件配置存在且请求空间仍在离线授权目录，不能在配置读取失败或团队授权撤销后悄悄回退到本地个人空间。TS 交接副本具备按插件／聊天复用或创建会话、旧消息键升级、团队项目绑定、标题优化和公开模型绑定校验；拒绝跨空间复用已有聊天或项目。真实 Native Worker 与 TS 副本对同一输入的路由元数据已对照；Native 重复路由现也会更新显式托管模型来源。生产入站路由仍由 Native Worker 执行，尚缺渠道服务真正在线端到端验证。

> 渠道配置与控制入口追加：`plugin:list` 只返回请求空间的渠道，自动补齐内置渠道时也只处理该空间的项目与配置；Renderer 切换空间后清空旧渠道缓存并重新拉取，迟到响应不会回填。新增渠道明确写入所属空间，更新、删除、启动、停止、状态及普通发送在 Main 核对插件持久化归属与离线团队授权；普通项目绑定不能隐式改变渠道归属。渠道专用工具与 IPC 入口也按插件归属核验，撤销授权后拒绝继续调用。流式回复的开始、更新、追加和结束现在要求显式空间、当前插件归属及团队离线授权，已有流句柄还绑定初始空间、插件、聊天及服务实例；撤销授权或服务停止／替换后的旧句柄不可继续更新，避免跨空间、跨聊天或跨服务复用；普通回复使用任务自身的空间，不再从可能尚未加载的 Renderer 渠道缓存推导。Main 的临时消息去重按插件及聊天限定，Renderer 的去重键包含空间、插件、聊天和来源消息 ID，避免不同聊天碰巧使用相同 ID 时误丢；Main 现在将入站任务按来源身份写入独立的 TS SQLite 待投递箱，Renderer 在 Agent 处理及最终渠道发送成功后才回执；进程重启及窗口重载后可重试未回执任务。最近投递但尚未到重试时间的任务现在也会安排到期重试，避免启动时查询结果暂时为空导致任务搁置。主进程不再广播原始入站消息；自动回复任务改为只投递给已向 Main 登记并获授权、且实际安装自动回复监听器的一个同空间主窗口。独立会话／SSH 窗口不能领取任务，即使它们处于聚焦状态；未登记或重载中的窗口也不接收，旧登记请求乱序完成不能覆盖新登记。Renderer 仍复核任务空间；频道任务排队或运行时禁止切换工作空间，切换的异步校验期间也暂缓接收新任务。主窗口不可用时任务保留并在重新登记后投递；远端发送已成功但本地未收到确认时仍可能重复发送，真实多窗口端到端与崩溃恢复验收仍待完成。

> Project Wiki 空间隔离追加：Wiki IPC 现要求请求空间与 Main 已登记的窗口空间一致，团队空间还需通过离线授权目录；读取、生成和导出在异步工作后重新核验。入口先把项目路径规范化为绝对真实路径，避免构造派生键碰撞旧本地个人键。旧本地个人 Wiki 的 Native 键与文件缓存路径保持不变，其他空间对同一项目路径使用空间绑定的不透明键及独立缓存，避免个人／团队之间读取同一 Wiki 文档。Wiki 四表已纳入 TS 交接契约；TS 副本可读取 Native 写入的个人／团队文档，并按空间事务化更新文档、节点、文件快照及生成记录，删除时清理该空间的关联记录。生产 Main 现默认通过只读 TS Worker 查询同一活跃 Native 数据库的 Wiki（`OLA_TS_WIKI_READS=0` 可关闭），失败回退 Native；同一份真实 Native 数据的个人／团队读取对照、备份后的续写与跨空间拒绝测试通过。桌面写入仍由 Native Worker 持有，真实 Electron 多窗口及授权撤销联调仍需验证。

> 桌面自动化流程空间隔离追加：Native `desktop_flows` 增加 `workspace_id`，旧记录回填本地个人空间；列表、更新和删除按空间限定，跨空间同 ID 覆盖被拒绝，删除时清理关联步骤与运行记录。Main 的 JSON 回退文件也按空间隔离，旧个人文件路径保持兼容。录制只收集发起窗口的输入步骤，窗口销毁时结束录制；流程 IPC 核对窗口已登记空间及团队离线授权，异步列表与保存返回前复核授权。Renderer 随请求传递当前空间并丢弃切换后的迟到列表，录制或回放期间拒绝主动切换空间。真实 Native 旧库回填、跨空间读写及 Main 文件／IPC 隔离专项测试通过；三张流程表现已纳入 TS 交接仓库并通过真实 Native 备份续写测试；真实 Electron 多窗口录制／回放和授权撤销验收仍待完成。

> QQ 网关续连状态追加：生产 `QQService` 已不再调用 Native 的 `channel/qq-session-*` 文件路由，改由 Main TS 将短时续连状态原子写入 `~/.ola/qq-bot/sessions`，Unix 文件权限为 `0600`。文件名使用工作空间与插件 ID 的 SHA-256 键，避免不同空间或旧文件名清理规则碰撞；同键写入和清理由队列排序，旧 Native 状态文件不再读取（其原有有效期仅五分钟）。QQ 启动、入站消息向 UI 分发和对外发送前核验团队离线授权，撤销后拒绝继续传递消息。Native 旧路由暂留供回退，不代表全部渠道运行时已迁移。离线隔离、过期和写入／清除竞态测试通过；真实 QQ 网关在线续连尚待验证。

> 桌面流程交接补充：三张流程表现已纳入 TS 交接字段契约，目前连同后续纳入的 QQ 唤醒窗口 v2 表，契约总数为 37 张。TS 业务库副本可按空间列出、保存及删除流程，事务化同步步骤并在删除时清理运行记录；真实 Native 数据库备份后的续写、跨空间拒绝及捕获文本遮蔽测试通过。生产流程持久化仍由 Native Worker 与 Main 文件回退承担，尚未切换默认路由。

> 桌面流程只读金丝雀补充：Main 现默认经只读 TS Worker 按空间列出活跃 Native 数据库中的流程（`OLA_TS_DESKTOP_FLOW_READS=0` 可关闭），异常回退 Native；同一真实 Native 数据库的个人／团队／未授权空间结果与 Native 列表对照通过。写入和删除仍由 Native Worker 执行，Main IPC 返回前仍须复核窗口空间与团队离线授权。

> 桌面回放授权补充：回放会按动作类型而非可修改的风险字段要求一次用户确认；截图前后的异步间隙会在发出键鼠动作前再次确认团队离线授权和取消标记。专项测试覆盖低风险标记不能跳过确认、用户拒绝无输入，以及截图期间撤权后无输入。

> 桌面回放运行记录补充：Native 与 TS 交接副本现均可按流程归属空间开始、结束和列出运行记录，跨空间变更被拒绝；Main 回放在 Native 可用时记录开始和成功／失败／取消终态。Native 不可用时按工作空间在本地文件中原子保存运行记录，Native 恢复后合并展示两边历史；设置页显示最近记录。Native 结束写入失败时会用同一运行 ID 写入本地终态，但 Native 原记录仍可能停留在运行中；文件系统也不可用时可能缺失记录，后续仍需对账与恢复。录制时省略的文字输入步骤会标记为需复核，并禁止误当作成功流程回放。

> 回放并发边界补充：取消只标记当前回放，直到等待／截图／输入循环及运行记录收尾完成后才释放占用；回放期间拒绝改写或删除同一流程，删除进行中也不允许该流程开始回放。末尾等待／截图后的授权与取消再次复核可防止取消被误记为成功。

> 桌面流程离线优先补充：Main 现在按空间合并 Native 和本地文件流程，离线新增流程不会因 Native 返回其他记录而消失；删除先写入空间限定墓碑，本地删掉后即使 Native 返回过期记录也不再复活，重新保存同 ID 才清除墓碑。保存、删除和回放对同一流程增加并发门禁；运行历史也过滤已删除流程。设置页打开时会在后台进行每轮最多 20 项的授权对账，将本地新增／更新、墓碑删除与终态运行记录幂等补入 Native；真实 Native 数据库和授权撤销专项测试通过。对账游标现在按操作键推进，前批持续写入失败或已成功项目从候选集消失时，后续项目仍可获得尝试机会。墓碑与本地副本仍保留供离线访问，生产写入所有权尚未切给 TS，完整跨设备同步与端到端验收仍未完成。

> 旧版 WebDAV 同步边界：v1 bundle 为全局数据库快照，没有工作空间标识，不能作为个人／团队跨设备同步实现。同步 IPC 现只接受已登记的本地个人空间主窗口；自动与手动运行在已授权目录出现托管个人／团队空间时均拒绝旧版同步。Native 在捕获或应用前若检测到非本地个人空间数据也会拒绝，并拒绝带团队 `workspace_id` 的传入记录。此门禁只阻止已知的跨空间数据进入旧格式，不等于完成空间化同步；旧远端 bundle、无空间列的关联表及文件域仍须在新协议下逐项设计和验证。

> 远端 bundle 验证补充：下载的 gzip JSON 现在对压缩体与解压体分别设大小上限，并在合并前校验 v1 版本、记录与墓碑结构、唯一键、各记录哈希、域计数及整包内容哈希；带非本地个人 `workspace_id` 的数据库记录被拒绝。此完整性哈希并非签名，不能证明远端来源可信；带工作空间身份及授权的 v2 业务运行尚未接线。

> 空间化同步传输基座：v2 WebDAV 路径从 API 地址、账户 ID 与工作空间 ID 共同计算不透明哈希，和旧 v1 全局文件分离；下载／上传均校验 v2 manifest 的空间哈希，数据库记录要求直接带相同 `workspace_id`，墓碑要求带相同 `workspaceId`，暂不接受无直接归属的关联行和文件域。v2 首次上传要求条件创建，替换已有远端状态要求强 ETag，并在上传前复核；缺失／弱 ETag 不再退化成无条件覆盖。这只是传输与契约基座，尚无全域空间化数据库快照、生产授权后的合并应用、自动调度或端到端跨设备接线，不能启用为产品同步。

> 空间化绘图历史切片：TS 接管仓库现可从已交接数据库按空间生成 v2 `draw_runs` 包，并在预校验整包后通过单个 SQLite 事务按空间应用记录／墓碑；真实 Native 快照后的团队记录恢复、个人数据不受影响、跨空间 ID 覆盖拒绝及批中失败整批回滚测试通过。此事务只覆盖绘图表，尚非跨领域原子事务；远端冲突裁决、合并后的基线提交及生产授权仍未实现，因此不能作为完整同步入口。

> 空间化同步元数据迁移：TS 交接库的独立 v2 schema 现有按 scope hash／工作空间／提供方隔离的基线和墓碑表，支持事务化替换、重启后读取、重复键失败回滚，以及相同 hash 被不同空间复用时拒绝写入。绘图快照在单个 SQLite 事务中读取记录、识别已同步基线里本地缺失的记录并首次持久化墓碑，避免扫描期间重建记录造成误删；重复扫描或仓库重启不会改写删除时间，重建后的记录不携带旧墓碑，其他提供方不会继承该墓碑。绘图域现有纯三方合并决策，能区分单边更改、删除、并发修改与并发创建，冲突必须显式选择；基线已有记录在一侧无记录也无墓碑时会拒绝继续，以防静默复活或误删。合并前会验证远端 `draw_runs` 行的表名、ID／空间归属、必需字段、JSON、时间和持久化约束，避免上传成功后才发现记录无法本地应用；上传前还会对全部合并记录与墓碑 ID 查询本地全局归属，拒绝伪造个人空间既有 ID 的团队记录。绘图合并结果现可在远端条件上传后进行本地事务化提交：对捕获时的记录／基线／墓碑修订令牌做比较，全部记录应用与该域的新基线、墓碑同事务写入；离线期间本地编辑会使提交失败而不覆盖新数据。独立绘图运行器现串联捕获、远端下载、冲突裁决、条件上传、远端回读确认与本地提交；冲突不会上传，上传失败不会推进本地基线。真实 Native 备份与模拟传输的流程测试、WebDAV 适配器加隔离 HTTP 响应的首次上传／条件替换／远端修改下载合并测试通过。此运行器尚未接入生产调度或真实账号授权，其他领域和真实 WebDAV 服务／Electron 端到端验证仍未完成，不能视为完整跨设备同步。

本目录记录实际落地状态，不将新模块存在或单元测试通过等同于完整替换。
当前桌面生产入口由 Main 托管的 TS Runtime 与 TS BusinessRepository 提供；旧 Worker 源码、启动、发布和生产回退路径已清理。用户数据库接管、真实主站联调和跨平台发布仍按验收台账保留为最终门禁。

## 已落地的纵向链路

- 显式 `ModelSource` 和严格输入校验，运行绑定优先于会话，后者优先于空间默认。
- 桌面工作空间默认值新增显式模型来源；旧 Provider/Model ID 保留读取和写入兼容。模型选择器、辅助模型及新会话默认读取统一入口。
- 未登录可选择本地来源，托管来源必须同空间且授权有效。新运行时不把撤销绑定替换成本地模型。
- 纯 TS Agent 多轮循环、宿主注入的模型与工具接口、最多四个并行只读工具、共享资源写锁、权限拒绝、取消、重复工具调用保护和轮次上限。
- 独立 Node 服务和 CLI：本地带鉴权、有界帧和版本／能力协商的协议，运行提交/查询/回放/取消、持久化交互响应和断开客户端继续运行。
- 独立 SQLite Worker 持久化新运行事件和待处理交互，提交去重、同会话串行、默认四个根任务并行、取消终态处理。恢复时中断未完成任务，不自动重放未知副作用或旧交互。
- 待处理交互和已提交回答在写入 SQLite 前递归遮蔽常见凭据字段；原始回答只在正在等待的调度器内存中交给本次运行，不能通过快照、事件或重连回放泄露。
- 运行历史列表与快照在数据库读取前后均重新确认当前空间授权；团队离线授权若在查询期间被撤销，旧结果不会返回给客户端。
- TS 运行日志 v3 现在索引会话／空间归属，并在创建运行的 SQLite 事务内拒绝把已有 `sessionId` 用于另一个工作空间；同空间重试与历史数据仍保留。此约束防止 TS 运行记录自身发生跨空间会话混用，尚不能替代正式业务会话库的持久化归属校验。
- 桌面 TS 运行提交现会等待新会话的 Native 持久化创建完成；Main 随后用空间限定的业务会话查询核对 `sessionId`，不存在或属于其他空间时拒绝运行，并在异步查询后再核验窗口空间。独立测试验证创建先于提交、跨空间或缺失会话不触发 TS 调度。当前校验仍依赖 Native 生产会话库；正式切换后必须由 TS 单写入仓库接管同一归属检查。
- DesktopRuntime 测试现把含 bearer token 的本地连接描述文件注入隔离临时目录，不再写默认 `~/.ola`；服务停止抛错或令牌公布后的启动初始化失败时也会清除描述文件。故障注入测试覆盖两种失败路径。真实用户目录中已有的描述文件不在本轮自动清理范围内。
- 显式工作空间的生产会话列表与按 ID 读取现默认走 TS 只读 Worker，Native 仍是唯一写入者；无空间参数保持旧路由，TS 读失败回退 Native，`OLA_TS_SESSION_READS=0` 可立即关闭该切片。提升前补齐 `external_chat_id`、任务档案及锁定字段、空值默认和 Native 列表排序；隔离真实 Native Worker 对照覆盖个人／团队、全字段、分页及跨空间拒绝。其余已实现的空间限定业务只读入口也已独立默认开启，均保留关闭开关和 Native 故障回退；写入和正式业务库所有权尚未切换。
- 生产默认连接描述文件现位于 `~/.ola/runtime-private/desktop-runtime.json`，由独立私有目录保护，不再为了发布令牌而改动既有 `~/.ola` 目录权限。发布拒绝符号链接或共享父目录，读取拒绝符号链接文件；隔离测试覆盖权限不变、链接拒绝和 CLI 连接。
- 桌面 TS Runtime 的运行列表／快照／提交／取消／交互 IPC 现在还要求请求空间与发起窗口的已登记空间一致；异步列表与快照返回前再次确认窗口仍在原空间。工作空间切换请求也必须携带来源空间并与窗口登记一致。Renderer 的 TS 运行重连等待窗口登记确认，避免启动和切换时误判为跨空间请求。隔离测试覆盖跨窗口空间拒绝、迟到列表丢弃、来源空间伪造及登记并发；完整 Electron 多窗口验收仍待完成。
- 桌面 TS Agent 在提交及排队运行正式启动时重新读取离线团队授权；账户退出或空间目录更新时，Main 会通知 TS 调度器中止已运行的被撤权团队任务，并取消排队任务，个人空间不受影响。离线目录缓存满 30 天时有主动定时复核，即使 UI 没有再次请求；在线刷新成功会重排期限，离线且缓存失效会撤销团队运行。模型请求在目标解析后及响应返回后再检查取消并丢弃迟到响应体；工具在审批、资源定位和执行结果边界检查取消，不向模型回传撤权后的结果。本地模拟流式模型与真实 DesktopRuntime 的集成测试已验证目录撤权使正在读取的 HTTP 响应关闭、运行进入 `cancelled`。已开始执行、且不遵守取消信号的外部工具无法通用地回滚副作用，需逐工具审计和 Electron 端到端验证。
- 团队目录或账户身份请求收到明确的 HTTP 401/403 时，Main 立即清除账户绑定的离线目录缓存并广播空团队目录，触发上述运行撤权；纯网络故障才允许使用未过期的离线快照。账户客户端测试分别覆盖 401、403、离线回退及缓存删除。
- 专用 SQLite 连接持有服务所有权锁，阻止同数据目录双服务；进程异常退出后操作系统释放锁。
- 模型适配层覆盖 OpenAI Chat、Responses HTTP、Anthropic、Gemini 与 Vertex AI 的文本/函数工具流式路径；凭据仅由宿主传输层解析。保留 Anthropic 签名、Responses 加密推理项及 Gemini thoughtSignature 的下一轮回放，拒绝不完整输出。
- `AccountGatewayTransport` 以工作空间、资源和会话标识调用共享的 Main 账户网关契约；运行时没有登录令牌、短期票据或托管供应商 Key。桌面 `mainAccountGateway` 已封装现有受限账户客户端，现有桥接仅新增 Responses 白名单，桌面引擎尚未切换。
- 会话与项目库新增受校验的公开 `model_source` 过渡列；新建或手动绑定写入显式来源，旧 `provider_id/model_id` 继续兼容读取。项目绑定会随新会话继承；会话和项目的托管来源均须与所属空间一致。Cron 定义和运行记录已保存公开绑定；TS Cron 运行以任务保存的 `workspaceId` 为数据与授权归属，本地模型可在任意空间使用，托管来源必须与任务空间一致。渠道配置与自动回复路由也保存并验证公开绑定，旧渠道字段保留读取兼容。
- 账户令牌和 Mesh 身份拒绝 `basic_text`；登出删除旧账户令牌文件，避免重新加载旧账户。
- Renderer 账户目录刷新使用身份代次保护；Hydrate 失败、登出和晚到的旧目录响应均不能恢复已撤销账户的工作空间目录。
- 旧 Cron 路径收到 Worker 中断时结束等待；旧目标状态表重建增加事务。
- TS Runtime Dispatcher 的请求上下文与托管 HTTP 处理器解耦，CodeGraph 使用固定的 TypeScript/WASM grammar 资源。
- Vitest 行为测试、独立类型检查、内核依赖边界检查及 CI 质量门禁；CI 和生产发布流程不构建或运行 .NET。

## 当前能力边界

新的 CLI 是 TS Runtime 的正式入口。`npm run cli -- …` 使用 TS Runtime bundle；旧 CLI/Worker 启动路径已从生产构建删除。

- CLI 当前只开放 `local-personal`、一个显式配置的本地模型（五种协议可选）和文本对话。传入显式 `--workspace-root` 可注册受 `realpath` 边界限制的工具；每次 `run` 还必须用 `--tools` 明确声明本次模型可见的工具快照。
- Responses WebSocket 的本地 session-scoped transport、协议全量多模态能力、各服务商特殊参数及真实端点联调仍需继续对照；当前不宣称已达到旧协议的完全等价替代。签名回放保留在本次运行的模型上下文，不写入公开 UI 事件；跨重启续跑尚未实现。
- Agent/工具/调度内核由 TS Runtime 提供，写入与 Shell 仍经 Main 侧持久化审批。生产资格边界不再启动 sidecar 或 Native Worker；尚未支持的能力必须显式失败并记录在验收台账，不能静默降级。创建仅允许既有真实父目录、不可覆盖已有文件、不可跨越符号链接，并必须经现有审批卡片和受限 IPC 明确批准。
- CLI Key 通过服务环境变量显式传入并只在内存使用；UI 只写凭据库、OAuth 与口令导出尚未迁移，不能宣称供应商 Key 已从 Renderer 全面移除。
- Plan Mode 例外更新：上一条 Agent 能力边界中的“问答与计划审批专用 UI、子 Agent 尚未接入”已由当前 TS Plan 文件生命周期、`AskUserQuestion`、`Agent` 子运行和 widget 结果接线覆盖；SSH 远端工具、复杂插件能力、真实 Electron 端到端及生产 Native 写入权切换仍未完成。
- 新日志库位于所选目录的 `runtime-v2`，不打开或接管旧数据库。
- Main 的会话、项目、计划、任务及显式工作空间的消息读取／搜索现由按工作空间限定的 TS BusinessRepository 提供；查询失败 fail-closed，不再回落 Native Worker。现有渠道会话、用量、Goal、代码变更日志、QQ 唤醒、Wiki 和桌面流程读写入口也由 TS 服务提供。
- Native 当前会在部分消息读取时修复重复或缺口 `sort_order`，TS 只读 Worker 不能执行这项写入。默认 TS 消息读取在同一 SQLite 快照中检查排序异常并回退 Native 修复；真实 Native 对照覆盖修复前拒绝、修复后消息／用户消息／定位／标记／分页／请求上下文／窗口的结果及跨空间隔离，包括长会话、压缩标记与 `headLimit=0`。消息计数已改为与 Native 相同的 `sessions.message_count` 缓存值，测试覆盖缓存值暂时落后于明细的情况。P8 交接副本现在于提升前显式修复历史排序异常，回退基线不变；生产消息写入仍由 Native 持有。
- 消息搜索现在由 Renderer 携带活动空间，Main 要求显式空间并在查询前后核验团队离线目录；TS 和 Native 回退查询均在 `LIMIT` 前按空间过滤，再对结果逐个复核会话归属。真实 Native 数据用跨团队命中占满 `limit=1` 的场景验证：本团队结果不会再因其他团队的命中而丢失。Native 的无空间搜索仍保留给内部兼容调用，但 Renderer IPC 不再提供跨空间全库搜索。
- 桌面会话列表／按 ID 获取及消息列表、用户消息、标记、定位、分页、请求上下文、窗口和计数 IPC 现拒绝未显式指定空间的 Renderer 请求；Main 读取前按团队离线目录核验空间，读取后再次核验，避免撤销期间返回已取得的数据。聊天导出分页与插件自动回复的会话读取已补齐空间参数。旧 Main 内部 DAO 的可选空间参数仍为兼容入口；桌面 IPC 不再借此作全局读取。运行时测试覆盖无空间请求在触达数据库前被拒、团队授权在读取期间撤销时不返回消息。其他数据库域 IPC 的窗口绑定与授权仍须逐项审查，不能把这一步视为整个桌面数据库的隔离验收。
- 项目、计划和任务的桌面读取 IPC 也要求显式工作空间；读取前后按团队离线目录复核，拒绝无空间的旧字符串请求及撤权期间的迟到响应。插件自动回复的项目按 ID 查询已携带所属空间。Runtime IPC 测试覆盖无空间请求不触达 DAO、项目查询中途撤权不返回结果。相应写入 IPC、Goal 等关联域和窗口绑定仍需继续审查。
- 项目与会话的创建、更新、删除，以及确保默认项目／清空会话的桌面写入 IPC 现要求显式空间并在调用 Native 前验证团队离线目录；不再把无空间字符串／空请求默认为本地个人空间。Runtime IPC 测试覆盖无空间写入与已失去离线授权的团队写入均在触达 Native DAO 前被拒。Native 事务内部的撤权时序、其他业务域写入和窗口绑定仍未在这一步完成。
- 计划和任务的桌面创建、更新、删除 IPC 也已拒绝无空间默认写入；创建与按会话删除先核验持久化会话属于请求空间及团队离线目录，按 ID 更新／删除先核验空间。测试覆盖无空间和跨空间会话创建在触达对应 DAO 前被拒。Goal store 及其 IPC 仍以会话 ID 为主、缺乏完整的空间生命周期约束，是下一步独立审查项。
- Commands、Agents 与 Prompts 的本地目录和读取／管理已由 Main TS 目录适配器负责；Commands 保留 bundled 命令优先及创建模板，Agents 保留内置模板首次复制、frontmatter 解析和覆盖检测，Prompts 保留模板首次复制和本地覆盖。Soul 的内置、本地安装和市场列表／分类／下载已由 Main TS 接管；下载只允许固定市场源、拒绝重定向并限制响应大小。Skills 的内置同步、本地目录读取／编辑／导入／删除、风险扫描、市场 ZIP 下载和临时目录回收均已由 Main TS 接管，下载同样只允许固定市场源、拒绝重定向并限制大小。
- CodeGraph 生产入口为 Main 拥有的 TS/WASM 适配器，不存在 `OLA_CODEGRAPH_RUNTIME=dotnet` 或 .NET Worker 回退。TS 使用独立数据目录和 SQLite Worker，提供索引、状态、统计、文件树、符号／引用搜索、相对导入邻居查询和进度事件。18 个台账语言项均有固定 grammar/诊断映射；高级语义对照与性能证据仍由 P7 台账门禁约束，能力缺失必须显式诊断而不是切换到 .NET。
- 工作台已有按窗口／空间隔离的布局与会话标签起步；多标签全面体验、拖动分屏、独立窗口协同及 UI 全页改造仍未完成。浏览器的 Main 所有权服务现在会验证现有 `<webview>` guest 的 Electron 宿主关系，并登记显式工作空间、Profile 与用户控制租约；`WebContentsView` 已默认接入创建、bounds、导航、页面事件投影及 HTTP(S)/新窗口安全边界，并保留显式 legacy 回退，完整浏览器自动化调度和视觉验收仍待完成。会话或项目上下文会由 Main 再次验证空间归属，凭据注入只接受已登记 guest。
- 桌面六平台 Node 打包、真实主站联调、性能及视觉验收尚未完成。
- 桌面空间切换的唯一 Renderer 写入口已集中到 `switchWorkspace`：切换前检查 Agent／子 Agent／后台进程／频道／SSH／Draw／Cron／桌面流程是否空闲，复核窗口与授权空间，调用 TS Runtime workspace switch，并在切换后清理并重挂载空间状态。真实 Electron 多窗口并发切换与人工视觉验收仍需外部环境验证，不能仅凭该入口的静态覆盖宣称最终发布完成。
- 会话、项目、定时任务与渠道自动回复的显式 ModelSource 过渡存储已接入；渠道设置选择器已按本地与所属 Ola 个人／团队空间分组写入公开来源，且桌面实际模型请求仍走旧引擎。

## 本地验证入口

需 Node 24 或更新版本。先构建：

```sh
npm run runtime:build
npm run runtime:cli -- help
```

必须显式指定隔离数据目录；不默认读取真实 `~/.ola`。
服务端与客户端使用同一个 `--data-dir`：

```sh
npm run runtime:cli -- serve --data-dir /tmp/ola-ts-demo --provider lan --model your-model --base-url http://127.0.0.1:8000/v1
npm run runtime:cli -- run --data-dir /tmp/ola-ts-demo --provider lan --model your-model --prompt-file /tmp/ola-prompt.txt
npm run runtime:cli -- list --data-dir /tmp/ola-ts-demo
npm run runtime:cli -- watch --data-dir /tmp/ola-ts-demo --run RUN_ID
npm run runtime:cli -- cancel --data-dir /tmp/ola-ts-demo --run RUN_ID
```

服务端通过 `--protocol openai-chat|openai-responses|anthropic|gemini|vertex-ai` 选择协议，默认为 `openai-chat`。Anthropic 地址可带 `/v1`；Gemini 使用 `/v1beta`；Vertex 使用包含项目与地域的地址。

需要 Key 时，服务端增加 `--api-key-env ENVIRONMENT_VARIABLE_NAME`，不要将 Key 本身写在命令参数中。
客户端退出不会取消运行；服务端 SIGINT/SIGTERM 会取消当前运行并关闭数据库。
进程崩溃后重启会将未完成运行标记为 interrupted，要求检查可能已发生的副作用。
运行事件按序号分页读取；完成状态不代表客户端已读完历史页。

## 阶段状态和后续切换门禁

| 阶段  | 状态   | 当前证据与未关闭项                                                                                   |
| ----- | ------ | ---------------------------------------------------------------------------------------------------- |
| P0    | 通过   | 工作区基线和验收台账已固定。                                                                         |
| P1    | 实现中 | Electron 冷启动与 24 个页面路由 smoke 已通过；完整人工视觉、多窗口和旧新全量契约仍待验收。           |
| P2–P9 | 通过   | TS Runtime、数据接管、Agent/业务路由、CodeGraph、数据库交接和工作台证据已通过。                      |
| P10   | 实现中 | 页面级自动 smoke 已通过；全部既有功能页、输入法和人工体验验收仍未关闭。                              |
| P11   | 通过   | Main-owned 浏览器生命周期、Profile、控制权、导航安全和相关测试已通过。                               |
| P12   | 实现中 | 生产源码、构建、发布 staging 无 .NET 资产；真实主站联调及六平台原生安装/升级/启动/签名仍待外部证据。 |

`capability-inventory.json` 由 `node scripts/inventory-ts-migration.mjs` 生成，所有旧路由当前均标记为 legacy。
清单解析字面量注册及生成的 `AgentRuntimeContract` 路由常量；`verify:workspace-runtime` 与 `verify:codegraph-worker` 会将其与实时 `worker/routes` 双向对照。清单覆盖不代表功能等价或生产切换完成。

## 验证命令

```sh
npm run test:runtime
npm run typecheck:runtime
npm run typecheck
npm run lint:ci
npm run verify:ci-core
npm run verify:workspace-runtime
dotnet test sidecars/Ola.CodeGraph.Tests/Ola.CodeGraph.Tests.csproj --no-restore
npm run build
```

macOS 本机资源有限时可使用 `npm run build:mac:staged`：它只安装 Main 运行时外部依赖并复制 `sidecars/`，生成 `dist-staged-mac/` 下的 DMG、ZIP 和 unpacked 目录；签名／公证仍需在配置 Developer ID 证书的构建机执行。可用 `npm run verify:runtime-staging -- dist-staged-mac/mac-arm64 --platform=darwin` 校验 unpacked 资源。

测试使用临时目录、模拟模型端点和隔离 Worker，不使用用户账户、不访问收费模型、不修改真实用户数据库。
当前改动没有提交、推送或发布。

## 本轮验证结果（2026-09-17）

- `npm run verify:ci-core` 通过：覆盖 Main/Preload IPC 授权、渠道路由、Cron 去重、浏览器 Cookie/WebView 安全、CodeGraph、同步与 Mesh、工作空间隔离及受限托管模型桥接。该门禁不替代真实主站联调、Electron 人工流程或六平台发布验证。
- `npm run verify:workspace-runtime` 现用隔离 Worker 覆盖渠道路由创建的 `workspace_id/model_source`，以及跨空间模型、项目和既有渠道会话的拒绝。
- Node 24.21.0：9 个 Vitest 测试文件、25 项行为测试通过，包含独立子进程服务、客户端断开、强制终止及重启恢复。
- CodeGraph：329 项原有 .NET 测试通过。
- 应用与运行时类型检查、Lint、全仓格式检查、`verify:ci-core`、真实隔离 Worker 空间验证及生产构建通过。
- 锁文件相对实施前基线没有升级或移除原有包，仅新增 22 个测试依赖相关包。
- 以上为本机验证，不是六平台发布、完整 Electron 人工冒烟或真实主站联调结果。

## 持续验证结果（2026-09-18）

- 绘图同步冲突 ID 现绑定基线、本地和远端的具体记录／墓碑版本；远端或本地变化后，旧冲突裁决会被拒绝。团队授权在远端上传期间撤销时，运行器不会提交本地基线；已有交接库测试也覆盖本地修订变化时的事务回滚。当前 `npm run test:runtime` 为 168 个文件、612 项全部通过，`npm run typecheck:runtime`、应用类型检查、Lint、格式检查、生产构建及 `verify:ci-core` 通过。此项仍是未接入生产调度的绘图域分阶段验证，并非全域同步验收。
- Plans 已通过其 `session_id → sessions.workspace_id` 关系完成 Native Worker 数据库侧隔离：列表、按 ID、按会话读取，以及创建、更新、删除都要求匹配的工作空间。隔离 Worker 验证覆盖跨空间读取、创建、更新和删除拒绝；TS 的 legacy read canary 也已覆盖 Plans 的列表、按 ID 与按会话读取，并在异常时回退 Native Worker。
- 本轮 `npm run verify:workspace-runtime`、`npm run typecheck`、`npm run test:runtime`（89 个文件、340 项）与 `npm run format:check` 全部通过。
- 修正隔离 TS Runtime 编译穿透渲染性能模块时缺少 Vite `ImportMeta.env` 类型的问题；运行时仍只会在浏览器开发环境启用该性能采样，不影响生产行为。
- Node 24.21.0：`npm run test:runtime` 通过 88 个测试文件、338 项测试；`npm run typecheck:runtime`、应用 Main/Renderer 类型检查、`npm run lint:ci` 与 `npm run format:check` 全部通过。
- `npm run verify:workspace-runtime`、`verify:workspace-models`、`verify:managed-model-bridge` 与完整 `npm run verify:ci-core` 通过，覆盖离线空间默认、个人／团队模型归属、撤销绑定、账户网关和跨空间隔离。
- `npm run runtime:build` 与 `dotnet test sidecars/Ola.CodeGraph.Tests/Ola.CodeGraph.Tests.csproj --no-restore` 通过；后者为 329 项。生产构建已完成，但仍有既有的 Vite 动态／静态混合导入分块警告。
- 这些结果验证当前实现的质量门禁，不能替代真实账户／供应商端点联调、跨平台打包、Electron 人工流程和 Native Worker 单写入者退役；这些仍是 P8、P9–P12 的完成前提。

## Electron TS Runtime 装配修复（2026-09-18）

- 实际 `npm run dev` 冒烟发现隔离测试未覆盖的两项桌面装配缺陷：electron-vite 开发重建会清空动态 SQLite Worker 资产，而 Renderer 又将 TS Runtime MessagePack 通道错误拼为 `messagepack:ts-runtime:*`，与 Main 的 `ts-runtime:*:msgpack` 注册约定不匹配。
- `RunJournal` 在 Electron 默认开发应用中改从源码 Worker 对加载，生产和 CLI 仍使用构建后显式复制的同级资产；`launch-dev` 会在启动 Electron 前准备运行时资产。打包配置也解包 P8 接管仓库所需的 `business-worker` 及 schema。
- 新增 `verify:runtime-main-assets` 并纳入 `verify:ci-core`，实际构建并检查 Main Worker 资产、开发回退和通道契约。开发冒烟复测输出 `TsRuntime desktop host ready`，且不再出现 TS Runtime IPC 未注册错误。
- `config:get` 和 `settings:get` 也已移到首个 BrowserWindow 创建前注册，避免离线工作空间首屏读取持久化模型与设置时的未注册 IPC。冒烟复测不再出现这两项及 TS Runtime 的未注册请求。
- 本轮 `test:runtime`（88/338）、完整 `verify:ci-core`、类型检查、严格 lint 与格式检查均通过。
- 工作空间模型缓存读取现在对无效的持久化 `ModelSource` 失败关闭：它不会抛出导致选择器崩溃，也不会退回到可能已撤销的旧 provider/model。隔离状态测试覆盖该恢复路径。

## 协议迁移追加验证（2026-09-17）

- Node 24.21.0：10 个测试文件、42 项行为测试通过。新增签名回放、终止帧缺失、生成截断、认证头、地址规范化、绑定变化拒绝、流中断与空闲超时测试。
- Anthropic、Responses、Gemini、Vertex AI 分别通过无 Electron/React 的两轮模型/工具集成测试；仅执行隔离的模拟工具。
- TS 运行时及应用类型检查、Lint、应用生产构建通过；CLI 重新构建并验证协议选择帮助入口。构建仍有既有动态/静态混合导入提示。
- Electron Main 的 TS Runtime 现可在本地模型与已授权的 Ola 托管资源之间选择传输；托管资源每次调用重新读取 Main-only 空间／资源目录并经账户网关取短期票据。Renderer 聊天入口尚未切换，不能将此基础接线视为完整桌面迁移。
- 尚未将协议测试等同于真实主站/供应商联调、桌面切换或高级能力完整迁移。

## 调度与绑定追加验证（2026-09-17）

- Node 24.21.0：10 个测试文件、45 项行为测试通过。交互在 SQLite 事务中先持久化后通知；重新连接可读取待处理交互，跨工作空间响应被拒绝，取消和无人值守交互不会永久等待。
- Native Worker 编译通过。会话 `model_source` 列在写入和更新时验证为公开 ModelSource JSON，不接受 Key、票据或额外字段。
- Shell IPC 现由 Main TS 本地执行器处理；输出、取消与执行 ID 均以受信任的拥有窗口为边界，原 Native Shell 路由仍保留但不再作为桌面 Shell IPC 的执行路径。
- 当前为过渡存储和服务契约，尚未证明真实桌面 Main、账户网关、审批页面和所有后台入口的端到端接线。

## CodeGraph WASM 基座验证（2026-09-17）

- 固定 `web-tree-sitter` 0.20.8 与兼容的 `tree-sitter-wasms` 0.1.13，避免较新的运行时与旧语法模块 ABI 不匹配。
- 工作区扫描只将扩展名映射到实际可加载的固定 WASM grammar；例如该固定包没有 Ruby grammar，因此 `.rb` 会被明确跳过，不会把重复解析失败误报为项目索引故障。
- 19 个目标语言通过实际 WASM 解析测试；Haskell、Julia、Razor、Ruby 与 Dart 被明确标记为不可用，不能进入替代路径。Ruby 与 Dart 虽有本地模块，但在当前 `web-tree-sitter` ABI 下解析会失败，因此不能仅凭模块存在标记为可用。
- 打包配置会将两组 WASM 资源和 TS SQLite Worker 解包，供运行时按文件路径加载。默认使用 TS/WASM CodeGraph；`OLA_CODEGRAPH_RUNTIME=dotnet` 是受控回退入口。两者使用独立数据根，直到高级语义和性能对照达标，不允许双写同一索引。
- 本轮 Node 24.21.0 运行时测试为 16 个文件、99 项；运行时与应用类型检查、Lint、Native Worker 编译通过。生产构建已复验通过，且既有构建会报告动态与静态混合导入提示。

## CLI 与桌面试运行的受限文件工具验证（2026-09-17）

- CLI 端到端夹具验证了模型请求 `read_text_file` 时的完整两轮调用：工具目录仅在显式 `--workspace-root` 存在，工具结果回灌下一次模型请求，并通过运行事件输出。目录枚举和固定参数的 `git status --short --branch` 加入同一受限工具目录。
- 本地工作区文件读取、目录枚举和 Git 状态均受 `realpath`／工作区边界、路径遍历、符号链接逃逸及输出大小上限约束；Git 调用不经 Shell，也不接受模型提供的命令字段。写入工具尚未开放。
- 桌面开发试运行会将已持久化的工具生成和结果事件投影为现有工具卡片；未提供显式工作目录时不向模型暴露文件工具。
- 本轮 Node 24.21.0 运行时测试为 30 个文件、166 项；`npm run typecheck`、`npm run typecheck:runtime`、`npm run lint:ci`、`npm run runtime:build` 与聊天体验验证通过。Electron Main 在读取 Provider 主进程镜像后启动本地 TS 服务，退出和最后窗口关闭会停止服务；测试验证重复启动、令牌握手和描述文件清理。该覆盖不表示完整桌面工具、审批流程或旧 Worker 已迁移。

## 浏览器 Main 所有权登记验证（2026-09-17）

- 现有 Renderer `<webview>` 在 `dom-ready` 后经受信任的 IPC 将 guest WebContents、显式工作空间和 Profile 登记给 Main；Main 验证 guest 类型、宿主窗口和 host WebContents 的所属关系，并在 guest 销毁时删除登记。工作空间变化会轮换 tab 标识和 guest key，隔离 Profile 也按空间重建；Main 登记失败会显式展示错误，不能静默继续使用未登记 guest。
- 若登记请求携带会话或项目，Main 以明确的 `workspace_id` 查询对应实体；不匹配则拒绝登记。凭据注入除了 HTTPS、域名和宿主窗口检查外，必须命中该 Main 登记，不能向未登记或跨窗口的 guest 写入密码。
- `npm run test:runtime`（30 文件、166 项）、`npm run typecheck`、`npm run typecheck:runtime`、`npm run lint:ci`、`npm run verify:main-browser-service`、`npm run verify:credential-injection-authorization` 和 `npm run verify:webview-security` 通过。该验证没有替代 Electron 真实浏览器、WebContentsView、下载上传、Cookie 导入或用户接管的端到端验证。

## Commands TS 目录迁移验证（2026-09-17）

- Main 的 `CommandCatalog` 接管 `commands/list`、`commands/load` 和全部管理接口；它使用明确的用户目录及 bundled 候选目录，保持 bundled 同名命令优先、用户命令仍可在资源页编辑、创建模板和原有 Markdown 限制。
- 测试使用临时 bundled／用户目录，覆盖同名优先级、管理列表的有效标记、创建、嵌套用户路径保存、前置 YAML／系统命令标签拒绝以及目录越界拒绝；不会读取或修改真实 `~/.ola/commands`。
- `npm run test:runtime` 现为 31 个文件、169 项；`npm run typecheck`、`npm run typecheck:runtime`、`npm run lint:ci` 和 `git diff --check` 通过。此切换只覆盖 Commands，Agent、Prompt、Soul 和 Skills 仍由 Native Worker 实现。

## Agents TS 目录迁移验证（2026-09-17）

- Main 的 `AgentCatalog` 接管 `agents/ensure`、`agents/list`、`agents/load` 与管理接口；它将 bundled `.md` 首次复制到用户目录，兼容现有 name/description、工具、迭代次数、Profile、风险字段和提示正文的 frontmatter 语义。
- 测试使用临时目录，覆盖前置字段解析、首次复制、bundled／overridden 状态、合法覆盖保存、无效 frontmatter 与目录越界拒绝；不读取或修改真实 `~/.ola/agents`。
- `npm run test:runtime` 现为 32 个文件、171 项；`npm run typecheck`、`npm run typecheck:runtime`、`npm run lint:ci` 和 `git diff --check` 通过。Prompt、Soul、Skills 及 Agent 运行执行仍未迁移。

## Prompts TS 目录迁移验证（2026-09-17）

- Main 的 `PromptCatalog` 接管 `prompts/ensure`、`prompts/list` 和 `prompts/load`；它将 bundled Markdown 首次复制至用户目录，并优先读取用户副本。
- 临时目录测试覆盖复制、本地覆盖、扩展名兼容、空名称和路径遍历输入。随后全量 `npm run test:runtime` 为 33 个文件、173 项；此项不包含 Soul、Skills 或真实 Agent 执行迁移。

## Souls 本地路径迁移验证（2026-09-17）

- Main 的 `SoulLocalCatalog` 接管 `souls/builtin-list`、`souls/get-target-paths` 和 `souls/install`；它读取受声明的内置模板，并写入全局 `~/.ola/SOUL.md` 或显式项目根的 `.agents/SOUL.md`。
- 临时目录测试覆盖内置内容、全局与项目路径、目录创建、空内容与缺少项目根的拒绝。`npm run test:runtime` 为 34 个文件、175 项，`npm run typecheck:runtime`、`npm run lint:ci` 和 `git diff --check` 通过。
- 市场列表、类别与远程下载已切换到 `SoulMarketClient`；契约测试覆盖地址来源、响应规范化、分类降级、分页编码、认证头、错误处理及大小限制。下载只接受 `https://skills.ola.shop/api/v1/souls/`，并以 `redirect: 'error'` 禁止重定向。`npm run test:runtime` 为 36 个文件、180 项，类型检查、Lint、运行时构建和网络下载安全验证通过。真实市场联调仍待完成。

## Skills 本地目录迁移验证（2026-09-17）

- Main 的 `SkillCatalog` 接管 `skills/ensure-builtins`、`ensure-builtin`、`list`、`load`、`read`、`list-files`、`delete`、`resolve-path`、`add-from-folder` 与 `save`。它保持内置目录哈希标记、内置升级时保留本地改动、frontmatter 校验、原子保存以及名称／路径边界限制。
- 临时目录测试覆盖内置同步、保留本地编辑、读取和文件列表、导入、保存、删除、无效 frontmatter 和路径遍历拒绝。`npm run test:runtime` 为 37 个文件、182 项，`npm run typecheck:runtime`、`npm run typecheck:node`、`npm run lint:ci`、`npm run runtime:build` 与 `git diff --check` 通过。
- 风险扫描也已由 `scanSkillDirectory` 接管：它会拒绝缺失或无效的 `SKILL.md`，跳过符号链接，列出文件和代码脚本，并对脚本应用现有的 Shell、执行、网络、凭据、文件和外泄风险规则；脚本读取限制为 512 KiB。市场 ZIP 下载和临时目录清理仍由 Native Worker 处理。

## 运行日志迁移与终态投影验证（2026-09-17）

- `RunJournal` 的 SQLite schema 采用显式版本迁移：核心运行与事件表为 v1，持久化交互表为 v2。每步在独立 `BEGIN IMMEDIATE` 事务中执行，失败时回滚且不推进 `user_version`；测试覆盖保留旧运行数据的 v1 升级和损坏对象导致的原子回滚。
- TS scheduler 的 `run.status: completed` 会投影为既有 Agent UI 所需的 `loop_end`，让带工具的 Execute 运行可以提交成功结果，同时失败和取消仍投影为错误。
- 桌面 TS 运行会持久化目标 assistant message ID；同一工作空间的新窗口可从运行事件重建文本、工具卡片和待审批工具，并仅对原运行提交审批结果，不会重复提交模型请求。取消恢复为既有“已取消”终态。
- `runtime:build` 会为 CLI 和 Electron Main 复制 `journal-worker.mjs` 及 `journal-schema.mjs`；生产构建验证其均存在，避免动态 Worker URL 在打包后找不到同级模块。
- `npm run test:runtime` 为 81 个文件、295 项通过；`npm run typecheck`、`npm run typecheck:runtime`、`npm run lint` 与 `npm run build` 通过。仍未进行业务数据库停写、备份和 TS 独占接管。

## 消息空间写入边界（2026-09-17）

- 消息的新增、流式 upsert、清空、删除、截断、压缩产物插入和整段替换均采用显式 `workspaceId`。Main 在委派 legacy Worker 前查询会话的同一空间归属；缺失或不匹配空间会拒绝请求，而不是根据 Renderer 的当前空间推断。
- 该契约已经由聊天 Store 和重发流程传递；运行时测试、应用类型检查、Lint 与 diff 空白检查通过。消息请求上下文、窗口查询和搜索的完整 Repository 接管仍属于 P8 后续工作。

## 工具并发与资源锁（2026-09-17）

- `ToolExecutor` 保留每批最多四项只读工具的并行上限，并且不再为读操作占用资源锁；同一文件或目录的只读检查可以并发执行。写工具仍必须声明规范资源，并由跨运行共享锁串行执行。
- 行为测试覆盖相同资源读并发和相同资源写串行；全量运行时测试为 81 个文件、296 项通过。

## 工作空间切换的运行时裁决

- `workspace.switch` 由受认证的本地运行时服务处理。它会在序列化调度队列中验证允许的工作空间，并拒绝任何队列中、执行中或日志中仍活动的运行，返回 `WORKSPACE_BUSY`。
- Renderer 的旧链路状态检查只是第一道用户体验保护；服务可用时，真正更新本窗口工作空间以前必须经过 Main IPC 的受信任发送方校验及运行时裁决。因此后台 TS 运行不会因另一个窗口未知其状态而被绕过。
- 服务不可用的旧链路启动阶段暂保留已有本地检查。这是过渡兼容，不代表多窗口的最终全局工作空间协调已经完成。

## 工作台布局空间／窗口隔离验证（2026-09-17）

- 工作台的侧栏、右侧运行面板、工作目录面板和对话宽度会按工作空间与逻辑窗口作用域保存；主窗口、SSH 窗口和每个独立会话窗口由 Main 在加载 URL 时传入稳定作用域，因此 Electron 的短生命周期窗口 ID 不会污染持久化布局键。
- 原有只按工作空间保存的布局键仍作为一次读取回退，升级后首次保存会写入新键；无效对象、`NaN` 与无穷宽度会被拒绝，宽度在保存和恢复时均会裁剪到安全范围。
- `tests/runtime/workspace-layout.test.ts` 覆盖有效快照、窗口作用域键、恢复裁剪及损坏持久化对象。此项只完成工作台布局数据隔离，尚不代表 P9 的多标签全面体验、拖动分屏、独立窗口全功能或视觉验收已完成。

## 本地 Grep TS 金丝雀验证（2026-09-17）

- 新增 `src/runtime/host/local-grep.ts`，可返回桌面文件搜索使用的结构化匹配、上下文、列号、计数、组合 pattern/notPattern、路径 glob、结果数与输出字节上限。
- `OLA_TS_GREP=1` 时，只有请求未使用 Git index/textconv、pathspec、multiline、basic-regexp 或类型过滤等尚未对齐能力才会进入 TS adapter；否则及默认配置仍由 Native Worker 执行。`verify:ts-grep-canary` 已加入 `verify:ci-core`，防止在未完成对照前取消该回退。
- `tests/runtime/local-grep.test.ts` 覆盖结构化输出、组合过滤、上下文、计数和截断；本轮 `npm run test:runtime -- --silent=true` 为 87 文件、326 项通过。该金丝雀不是最终切换：仍需录制语料与 Native 对照、Git 忽略及外部引擎策略、pathspec/类型/多行语义和性能门禁后才能将其设为默认。

## 浏览器 Cookie 空间授权验证（2026-09-17）

- `browser:import-cookies` 与 `browser:clear-cookies` 已在 Main 侧验证目标空间：`local-personal` 可离线使用，Ola 托管个人／团队空间必须存在于当前账户目录。目录刷新失败或账户无授权时拒绝操作，不能由 Renderer 提供任意 workspace ID 写入或清除其它空间 partition。
- `verify:browser-workspace-authorization` 已加入 `verify:ci-core`。它验证两条写入式 Cookie IPC 都经过 Main 授权，且本地个人空间不依赖登录。
- 此修复只覆盖 Cookie 操作的空间边界；Cookie 加密导出、完整 Profile 管理和 `WebContentsView` 生命周期仍属于浏览器迁移后续工作。

## 浏览器加密 Cookie 导出验证（2026-09-17）

- 内置浏览器 Cookie 现在可以从设置页导出为 `.ola-cookies` 归档。Main 会先验证当前窗口发送方和工作空间授权，再从该空间的隔离 session 读取 Cookie；本地个人空间可离线导出，托管空间需要当前账户目录仍授权。
- 归档 envelope 只保存空间、导出时间、格式版本和 `electron-safe-storage` 密文，Cookie 值不以明文写入；文件以用户私有权限创建。系统安全存储不可用或退化为 Linux `basic_text` 时明确拒绝导出。
- 此加密使用当前 OS 用户的安全存储，因此归档不承诺跨设备可恢复，也不会进入 Mesh 或普通同步。独立、经用户口令加密的可移植导出与归档导入尚未实现。
- `verify:browser-cookie-import` 和 `verify:browser-workspace-authorization` 共同检查加密、可信 IPC 和空间授权边界。完整 Profile 管理、`WebContentsView` 生命周期及真实 Electron 下载／上传 E2E 仍属于后续浏览器迁移。

## Execute MCP 运行时接线验证（2026-09-17）

- TS 桌面运行时已有 Main 托管 MCP 适配、调用限额、审批及资源锁；Execute 资格判定不再因“存在 MCP”而无条件回退 Native Worker。
- 仅显式传入的 `mcp__<serverId>__<toolName>` 安全标识可进入 TS 路径，标识字符和长度与 Main MCP adapter 一致；未知、格式错误或其它未迁移工具仍走 sidecar。运行的实际可用工具仍由 Main 的已连接 MCP manager 建立，Renderer 不持有 MCP 凭据。
- `ts-runtime-agent-eligibility`、`ts-runtime-text-eligibility` 和 `mcp-runtime-tools` 的运行时测试覆盖该资格边界、错误名称和 MCP 调用；本轮运行时测试为 87 文件、328 项通过。完整 MCP 配置快照、断线恢复和端到端 Electron 交互仍属于后续统一调度验收。

## 聊天模型绑定解析统一（2026-09-17）

- 聊天请求和自动路由提示都通过工作空间 store 的 `getModelSelection` 读取默认模型；该入口优先解析并验证 `ModelSource`，而不是直接读取旧 `modelSelections` 映射。
- 因此持久化升级后即使同一键残留了旧供应商／模型字段，已验证的本地、Ola 个人或团队绑定仍是唯一有效选择；不会因历史映射而悄然更换模型来源。
- `workspace-model-store` 回归测试覆盖类型化绑定覆盖陈旧旧映射。本轮运行时测试为 87 文件、329 项通过，应用类型检查与 diff 空白检查通过。

## Execute 声明式扩展接线验证（2026-09-17）

- 已启用并在项目激活快照中的 HTTP 扩展工具可走 TS Execute。Renderer 仅将扩展 ID 和确切 HTTP 工具名列入 RunSpec；Main 在构造运行工具时重新读取 manifest、配置和秘密，秘密不会进入运行记录、事件或 Renderer。
- 资格判定只接受该次快照中出现的精确工具名。JS 扩展没有等价的 Main 隔离运行时，仍明确保留 sidecar 路径，避免把名称匹配误当成能力等价。
- 运行时测试覆盖允许的 HTTP 工具和被拒绝的未声明／JS 工具，连同扩展 HTTP 执行器测试，本轮为 87 文件、330 项通过；应用类型检查和 diff 空白检查通过。

## 业务数据库接管快照门禁（2026-09-17）

- 新增 `createLegacyDatabaseHandoverSnapshot`：它只读打开 legacy `data.db`，先检查 `integrity_check`、外键和可识别表结构，再通过 SQLite Backup API 创建一致性快照；备份完成后会复查版本与表清单并写入 0600 权限的 JSON manifest。
- `npm run runtime:cli -- backup-legacy-db` 提供受控操作入口，可指定 `--source` 与 `--backup-dir`；默认面向 `~/.ola/data.db` 和其 TS handover 备份目录。该命令不停止 Native Worker、不打开源库写连接，也不改变 schema。
- 真实 P8 接管仍必须先停止 legacy 写入者、生成此一致性备份、执行版本化 TS schema 迁移并完成恢复演练；当前工具是这些不可跳过条件的前置门禁，而不是提前宣告接管完成。
- 真实 SQLite 夹具测试验证备份数据、表清单、版本、私有文件权限和不可用源库拒绝。本轮为 88 文件、332 项运行时测试通过，`runtime:build`、应用类型检查和 diff 空白检查通过。

## CodeGraph 不可用 grammar 诊断（2026-09-17）

- TS/WASM 索引器现在区分普通跳过与已识别但当前 ABI 不可用的语言：Ruby、Dart、Haskell、Julia 和 Razor 会出现在 `unsupportedFiles` 中，并附带稳定的 `CODEGRAPH_GRAMMAR_UNAVAILABLE:<language>` 原因。
- 独立探测确认当前固定 `web-tree-sitter` 0.20.8 与 `tree-sitter-wasms` 0.1.13 下 Ruby 加载会异常、Dart 会因语言版本不兼容而拒绝；因此没有将包内 WASM 文件错误标记为可用。Solidity 和其他已验证 grammar 的索引不受影响。
- workspace indexer 与 TS CodeGraph service 测试覆盖显式诊断、可用 Solidity 索引及语言路径映射；本轮运行时测试为 88 文件、332 项，应用类型检查与 diff 空白检查通过。

## 业务数据库交接契约预检（2026-09-17）

- `backup-legacy-db` 现在先以只读连接验证业务数据契约，再生成备份。它要求 `sessions`、`messages`、`projects`、`plans`、`session_goals`、`session_goal_events`、`cron_jobs` 与 `tasks` 存在，并验证会话和项目的 `workspace_id` 以及会话、消息、项目、计划、目标、目标事件、Cron 定义和任务迁移所需的主键、关系和排序字段。
- 缺少表或字段时命令以稳定的 `LEGACY_DATABASE_SCHEMA_UNSUPPORTED:<table>.<column>` 失败，不会生成看似可用的交接快照。未知的 legacy 表不会被删除或拒绝，SQLite Backup API 仍完整保留它们。
- 真实 SQLite 夹具覆盖合法业务库、缺少工作空间前置字段和原有快照完整性；本轮运行时测试为 88 文件、336 项通过，`runtime:build`、应用类型检查和 diff 空白检查通过。该预检不获得写权限，也不替代 P8 的停写、迁移和恢复演练。

## CodeGraph WASM ABI 升级结论（2026-09-17）

- 已实际验证 `web-tree-sitter` 0.27：它可以接受 Dart 的新语言版本，但无法加载当前固定 `tree-sitter-wasms` 0.1.13 的动态语法模块，导致现有 TypeScript、Solidity 等已支持 grammar 全部失效。
- 因此已回退到兼容的 0.20.8 运行时。Ruby、Dart、Haskell、Julia 和 Razor 继续以明确的不可用诊断呈现，不能把包文件存在误报为可索引。后续升级必须同时固定并验证新版 runtime 与全部 grammar 二进制的兼容矩阵，且须通过全语言语料对照后才可切换默认 CodeGraph。

## TS 业务库接管仓库基座（2026-09-17）

- 新增 `BusinessRepository` 及其独立 SQLite Worker。它使用 `ola_ts_schema_migrations` 的事务化、追加式版本记录，而不复用 C# 未版本化的 `PRAGMA user_version`；第一条迁移仅在完整验证 legacy 业务表结构和外键后写入“已验证所有权”记录。
- 该仓库目前覆盖会话、消息、项目、计划、目标、目标事件和任务七个核心域，并在每次按会话读取消息／目标事件、按空间列出会话／项目／计划／目标／任务时由数据库侧验证归属。计划与任务必须属于同一会话，避免迁移后产生跨空间或悬空的计划引用。其查询字段与交接预检契约对齐，防止某个旧 additive schema 少列时到运行中才失败。
- 构造仓库必须提供由 `backup-legacy-db` 产生的 manifest，且 manifest 的 `backupPath` 必须与实际数据库路径一致；它不能直接打开活跃 `data.db`。这是单写入者接管的代码级前置条件，但还不表示 Native Worker 已停写或所有领域都已迁完。
- 真实 SQLite 测试覆盖备份绑定、TS migration ledger、同空间读取、跨空间拒绝和缺失 manifest 拒绝。本轮运行时测试为 88 文件、336 项通过，应用类型检查与 diff 空白检查通过。

## 业务库接管写入与单写入者边界（2026-09-17）

- 交接副本的 TS `BusinessRepository` 已具备会话、消息、项目、计划、目标、目标事件和任务的创建、受限更新与删除能力；所有写操作在数据库侧再次检查工作空间。消息写入／删除与会话计数更新在同一 SQLite 事务中完成；删除会话会原子清理其消息、任务和外键关联记录，仍被会话引用的项目会明确拒绝删除。删除计划会在同一事务中解除任务引用；删除目标会清理其事件。空间归属字段不能通过普通更新接口改变。
- 每个副本使用独立 SQLite 写租约；一个仓库持有租约后，第二个进程会收到 `BUSINESS_DATABASE_LOCKED`，进程异常退出时由 SQLite 释放 OS 锁。仓库仍要求由 handover manifest 绑定的备份路径，不能直接打开活跃 `data.db`。
- 这些是 P8 切换前的实现与测试基础，尚未覆盖全部业务表、停写编排或 UI 默认路由；Native Worker 仍是生产唯一写入者。

## 业务库接管恢复演练（2026-09-18）

- 新增 `verifyLegacyDatabaseHandoverSnapshot` 及 `npm run runtime:cli -- verify-legacy-handover --manifest <manifest.json>`。它以只读方式复查 manifest 绑定、0600 备份权限、SQLite 完整性、外键、业务契约、表清单和备份大小，完全不访问或停止活跃 Native Worker。
- 直接调用备份 API 时也会在复制前检查旧库业务契约，并在写出 manifest 前复查副本；恢复验证与 TS 仓库启动均拒绝把原库或指向原库的符号链接作为交接目标，避免误写仍由 Native Worker 持有的活跃库。
- 演练不使用“每次打开都必须匹配原始 hash”的错误规则：接管后的 TS 仓库会合法写入其副本。它验证的是在切换前保存的恢复工件仍可安全打开并满足接管契约；正式回退仍须停服务并从一致性备份恢复，不能让旧写入者直接打开新 schema。
- 恢复校验现在允许合法写入后的数据库文件大小变化及 TS 自有的 `ola_ts_schema_migrations` 表，但仍要求原业务表清单、`user_version`、完整性、外键和字段契约保持有效。回归测试先让 TS 仓库写入足以扩容数据库的任务记录，再关闭并重开恢复工件；之前对此会误报 `LEGACY_DATABASE_BACKUP_MISMATCH`。
- 快照创建现同时保留一份独立的只读 `*.rollback.db` 基线；manifest 记录其大小与 SHA-256。恢复预检核查基线的权限、摘要、SQLite 完整性及旧业务契约；TS 仓库启动也要求基线存在且摘要匹配，不能在回退基线丢失或被修改后继续写入接管副本。这是切换前的回退工件，不是自动回退编排；正式切换仍须先停止 Native 写入者并验证同一批数据。
- Native Worker 管理器增加交接专用的永久停用操作：阻止后续自动启动／崩溃重启，终止旧进程并等待退出（超时后升级为强制终止）。独立子进程测试验证停用后请求不能悄悄重启 Worker。它尚未与所有桌面写入入口、TS 仓库提升及回退编排串成原子切换流程，因此不能单凭此操作宣称生产接管完成。
- Native Agent 管理器增加不可逆的交接接单门禁：先拒绝新 `agent/run`，检查 Main 的接单中请求及活动运行，再查询 Native Worker 的实时活动运行列表；启动中的请求在门禁生效后不能继续送入 Worker。它仍未与 Cron、渠道及其他旧写入入口串成完整桌面停写编排，也不会单独执行生产切换。
- Native Worker 共享请求入口增加交接排空门禁：永久停用进程前先拒绝新请求、等待已接收请求完成；超时或任何已接收请求失败则交接失败且接单保持关闭，不能在未知写入状态下制作快照。门禁覆盖通过此管理器进入 Worker 的同步请求，不替代 Agent/Cron 等已脱离请求生命周期的后台运行检查。
- Main 侧新增明确的桌面停写顺序：先阻止渠道服务启动，等待正在启动的服务并严格停止提供商，再排空已接受的渠道自动回复路由与任务投递；随后停止 Cron 并检查活动运行、封锁旧版同步定时器／新任务并等待在途同步结束、封锁 Native Agent 新任务及核对 Worker 活动列表，最后排空 Worker 请求并永久停进程。渠道待投递任务仍保存在独立 inbox，不在交接中丢弃。同步停写超时会保持拒绝新任务并使交接失败；提供方配置读取失败也不会留下虚假的运行中状态。任一门禁失败不得推进到下一步。它目前是交接协调器可用的停写回调，还没有接入生产路由提升、渠道任务由 TS 消费的完整切换及自动回退，因此不能直接用于用户数据库的正式切换。
- 渠道服务停止失败或启动失败后的清理也失败时，管理器保留该服务并标记错误，不再把可能仍持有连接的实例从活动表中删除；同 ID 重启与 P8 停写均会收到明确失败，避免残留连接绕过停写检查。
- 渠道任务的 inbox 确认现推迟到 Renderer 的 Agent 处理和最终渠道消息投递成功之后；发送接口必须返回约定的投递回执（允许空消息 ID 的 webhook 回执），投递失败时保留 `pending` 供重放。同一 Renderer 生命周期内，在途 delivery ID 不因短期去重缓存淘汰而重复执行。P8 停写在路由与投递排空后还要求 inbox 无待确认任务，否则以 `CHANNEL_TASKS_PENDING_DURING_HANDOVER` 拒绝切换；TS 消费者尚未接管此 inbox。该语义仍是至少一次投递：若远端已成功发送但本地未收到确认，重放可能产生重复消息，不能宣称端到端恰好一次。
- 渠道 Provider 启停等待与路由／投递排空各有 30 秒上限；卡住时分别返回 `CHANNEL_HANDOVER_STOP_TIMEOUT`／`CHANNEL_HANDOVER_DRAIN_TIMEOUT`，交接立即失败并保持新渠道请求关闭。Provider 已开始但迟到的事件在停写状态下不会再投递，停止超时的服务在实际完成前仍保留登记。专项回归覆盖启停超时、迟到事件和排空超时；这仍不代替查明并处理卡住的任务。
- 交接协调器已按“旧库契约预检 → 等待旧写入者完全停下 → 再检旧库 → 一致快照与独立回退基线 → 校验 → 打开 TS 单写入仓库”排序。真实 Native Worker 演练在停写回调内完成最后一笔会话写入并等进程退出，证明新仓库读取到该写入；预检失败不会触发停写。桌面其余旧写入入口、路由提升和失败回退尚未接线，不能执行生产切换。
- 交接协调器现会在打开 TS 写仓库前，从不可变回退基线实际恢复一个隔离的可写数据库，并验证契约及摘要；恢复失败则不提升 TS 仓库。真实 Native 最后一笔写入同时可从 TS 交接库和恢复副本读到。此门禁证明回退工件可恢复，不代表生产路由回退或切换后的新 TS 数据能无损回写旧版 Native。
- 快照备份目录现在必须是非符号链接的私有目录；交接不会为了备份而更改一个已存在的共享目录权限。链接目录和可被其他用户访问的目录会在创建快照前拒绝，隔离测试验证原目录权限不变。
- 停写快照记录源库真实路径及主库／WAL 摘要；恢复演练结束、TS 仓库打开前再次核对，若停写后仍有外部写入或路径换目标则拒绝接管。隔离测试在快照后写入旧库并验证此门禁失败。仍需在生产切换阶段持续封锁所有写入入口，不能将一次摘要检查视为永久锁。
- 交接协调器现要求快照源在复制期间保持稳定：对源库及 WAL 的前后摘要和 SQLite 数据版本做比对，若仍有写入则中止交接并清理本轮未完成的备份／回退／manifest 工件。故障注入测试在备份完成后、最终校验前模拟外部写入并验证拒绝。此门禁只能发现采样窗口内的变化，仍不能替代桌面所有旧写入入口的停写编排与持续阻断。
- Cron 调度器增加交接静止门禁：先停止后续触发，已有运行或尚未完成的收尾写入会使交接拒绝；普通取消定时任务不再错误地抹掉活动运行登记。Cron DAO 的定义／运行／日志写入和会修改恢复状态的启动加载现登记在途 Native 请求，静止后拒绝新写入；手动触发、被跳过的运行及其他 IPC Cron 写入同样经过该门禁。专项测试覆盖活动运行、在途写入拒绝及静止后重试。此门禁尚未与桌面总交接入口接线，其他业务域的 IPC／后台写入者仍须逐一停写。
- 新增 `drill-legacy-rollback --manifest <manifest.json> --restore-dir <isolated-dir>`：仅从只读回退基线复制到新建隔离目录，核对摘要和旧库契约，不覆盖活跃数据库。真实 Native Worker 测试确认恢复库既保留切换前数据、排除 TS 后续写入，也能由旧引擎继续写入；即使活动 TS 副本丢失，基线仍可独立恢复。此命令只生成演练副本，不自动把桌面路由切回 Native。
- 真实 SQLite 夹具覆盖有效恢复工件和备份丢失拒绝。当前运行时测试为 88 文件、338 项通过，应用类型检查、`runtime:build` 与 diff 空白检查通过。

## Cron 定义交接预检（2026-09-18）

- `cron_jobs` 已纳入 TS `BusinessRepository` 的交接契约，并提供按 `workspace_id` 限制的只读列表。Cron 定义含模型来源、执行环境、触发规则和投递设置，不能通过未限定空间的查询泄露到其他个人或团队空间。
- `cron_runs`、运行消息和运行日志也已纳入交接契约。TS 通过 `cron_runs → cron_jobs.workspace_id` 过滤列表和详情，只有获得该空间运行记录后才读取附属消息与日志；测试覆盖跨空间列表为空、详情为 `null`。
- TS 交接副本现支持 Cron 定义的创建、更新、启停、软删除、硬删除、触发计数，以及运行记录的创建和完结；定义写入校验会话／项目的同空间归属，拒绝跨空间托管模型绑定，字段契约覆盖来源与投递元数据。隔离 SQLite 测试覆盖跨空间创建、更新、删除拒绝。生产 Cron 的写入、触发去重、重启恢复和 UI 默认路由仍由 Native Worker 持有，直到完整的 TS 持久化与调度替代实现通过同一组行为测试。
- 运行记录创建会保存任务名称、提示词、来源会话／项目、模型及投递快照；TS 仓库还可在空间归属检查后原子替换运行消息、追加有序日志。完结仅允许从未完结的 `running` 状态转移，避免迟到的重复完成覆盖结果。隔离测试覆盖跨空间消息／日志拒绝、快照保留和重复完结拒绝。
- TS 仓库的 Cron 重启恢复现会在同一事务中，仅对指定工作空间的未完结 `running` 记录标记中断、禁用并软删除过期的一次性任务，再返回该空间仍启用的任务。真实 SQLite 测试覆盖个人／团队空间互不影响与重复恢复幂等。生产调度切换和端到端时序验证仍未完成。
- TS 仓库另提供调度入口 `startCronRun`：在单个 SQLite 写事务内检查空间归属、启用状态、同任务在运行中的记录、重复计划时间及一次性任务是否已触发，随后一起插入运行快照并递增触发计数。交接副本测试覆盖跨空间拒绝、重叠运行／重复时间去重及一次性任务只触发一次；目前尚未接入生产 Cron 调度器。
- `native-handover-contract` 集成测试从隔离的真实 Native Worker 初始化数据库并写入团队项目、会话、计划、Cron 定义及未完结运行的消息／日志；TS 业务契约预检、SQLite 备份、manifest 恢复检查及交接仓库读取均通过。TS 对副本的运行恢复和新增任务不会改变仍运行的 Native 原库。它不代表生产停写或所有权切换已完成。
- 同一隔离测试还演练了 Native 进程停下后的 TS 副本接管：TS 新建会话、释放写租约、重启仓库后仍能读到旧新两条会话，原始 Native 数据库仅保留旧数据。此演练不执行桌面生产路由切换或回退。
- 数据表覆盖清点：Native schema 声明至少 43 张业务表，TS 交接契约目前已覆盖 37 张离线空间业务表；默认生产所有权、完整桌面端离线／在线及 SSH 端到端验证仍未完成。`memory_roots` 的 Native 归属键、创建、按 ID 和列表读取现按 `workspace_id` 隔离，并对旧个人空间归属键保持兼容；Main 的会话准备从持久化会话推导空间。Stage1 产物的新增／读取、引用记录和根清理均要求根属于所请求空间；`memory_jobs` 已加工作空间列，创建会校验根及来源会话归属，按 ID 读取／结束／列表均限定空间，旧记录按根或会话回填。`memory_automation_entries` 现按空间校验关联并限定列表／按 ID／撤销，旧记录按根、任务、会话或项目回填；rollup 水位改用空间参与主键的 v2 表，保留旧表供兼容迁移。跨团队回归用例覆盖这些数据库入口。团队记忆的本地数据授权现可在网络故障时使用加密、账户与 API 地址绑定、最长 30 天的目录快照；服务端明确拒绝时不回退快照，登出时清除，托管模型仍要求在线授权。Renderer 离线保留目录但清空托管模型资源。全局记忆文件现按空间映射到 `~/.ola/workspaces/<sha256(workspace_id)>`，团队项目记忆映射到项目 `.agents/workspaces/<sha256(workspace_id)>`；本地个人空间沿用旧路径，项目 `AGENTS.md` 指令文件仍按项目共享。Renderer 快照、项目档案、每日 rollup 与 Native MemoryList/Read/Search 已改用空间路径，团队路径授权失败时不回退读取个人记忆。此项有路径单测、类型检查和 Native 编译验证；尚缺完整桌面端离线／在线及 SSH 端到端验证。其他本地数据入口的离线策略及 TS 接管仍待完成，不能把当前隔离视为整应用数据隔离。
