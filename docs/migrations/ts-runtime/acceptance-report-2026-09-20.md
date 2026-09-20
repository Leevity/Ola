# TS 迁移补充验收记录 — 2026-09-20

结论：**本机 TS 迁移与质量门禁通过，但未达到发布或目标退出条件**。台账当前 358 条路由、18 个 CodeGraph 语言全部具备 TS 路径证据（376/376）；P0、P2–P9、P11 已按证据通过，严格退出校验仍有 10 个 UI/发布与真实主站证据项未关闭。`staged-ts` 静态提示不计为通过。

## 可复核基线

- 基线 HEAD：`0ee559b8f15ca04a3f56259e275f67cef0447762`；[开始前工作区快照](worktree-baseline.json)记录 1368 个已有修改或未跟踪文件。旧 sidecar 源码按本补充计划已移除；原有生成物移至 `/tmp/ola-legacy-assets-20260920`，未执行工作区重置。
- [冻结能力清单](capability-inventory.json)含 358 条旧路由和 18 个语言标识；该清单的同名 TS 字符串统计不证明迁移完成。
- 本轮新增的[验收台账](acceptance-ledger.json)保留所有条目和 P0–P12、真实主站、六平台目标；每条“通过”都要求实现、生产路径、旧路径清除和测试证据。

## 本轮执行结果

整体计划预估完成度：约 99%。这是实施进度估计，不是最终发布完成度；路由/语言严格验收通过率为 376/376，退出校验器仍报告 10 项阶段/发布/真实主站证据未关闭。

| 检查                                                                                     | 结果                             | 限制                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run verify:ts-migration-ledger`                                                     | 通过                             | 只验证台账结构和已声明的证据字段，不证明功能完成                                             |
| `npm run verify:ts-migration-exit`                                                       | 按预期失败                       | Agent/渠道/部分 DAO 兼容入口和 376 个最终条目仍未完成证据                                    |
| `npm run verify:legacy-artifacts`                                                        | 通过（默认扫描 `out`，292 文件） | 旧 sidecar 源码和构建产物中的旧 native-worker 目录已移除                                     |
| `npx vitest run tests/runtime/no-dotnet-artifacts.test.ts --silent`                      | 1 文件、4 测试通过               | 验证无 .NET 产物门禁的允许和拒绝行为                                                         |
| `npm run test:runtime -- --silent --pool=forks --maxWorkers=1`                           | 217 文件、825 测试通过           | 已删除不可达 Native Desktop Flow reconciliation 回退测试                                     |
| `npm run typecheck`、`npm run typecheck:runtime`、`npm run lint`、`npm run format:check` | 通过                             | 静态质量门禁                                                                                 |
| `npm run build`、`npm run verify:ci-core`、`git diff --check`                            | 通过                             | CodeGraph 已切 TS/WASM；完整 Agent/渠道/六平台验收仍未完成                                   |
| `npm run verify:release-gates`、CLI `help`、cwd 隔离 CodeGraph 冒烟                      | 通过                             | CLI/资源路径可在独立进程和非仓库工作目录验证；签名、公证、六平台安装升级仍需外部证据         |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run build:unpack`                            | 受外部条件阻塞                   | Main/Renderer 编译通过，但 electron-builder 在依赖扫描阶段仍因本机约 8GB heap OOM (exit 134) |

补充实现：渠道命令 `/new`、`/status`、`/compress`、`/stats` 的生产调用已移除 Native Worker 回退，统一使用 TS BusinessRepository；TS 仓库不可用时明确失败。`tests/runtime/plugin-commands-ts-repository.test.ts` 的 5 项入口测试及现有业务仓库契约测试覆盖了这些路径。旧 .NET 路由源码和渠道真实端到端证据尚在，因此台账仅标为“待验收”。

本轮新增：宠物语音非流式合成、音频转写和图片生成均改由 Main 持有的 TypeScript IPC 路由处理（`pet:tts`、`pet:transcribe`、`image:generate`），Renderer 不再调用已删除的 Worker 请求接口；类型检查、运行时测试和核心 CI 门禁复跑通过。图片编辑输入、真实模型联调和端到端体验证据仍未完成。

本轮补充：新增真实 TS `BusinessRepository` SQLite 集成测试，覆盖数据库会话状态、用量统计、消息压缩、会话重置及跨空间隔离；4 个渠道/会话数据库入口已登记生产路径清除和集成证据，但因真实渠道端到端尚未完成，仍保持“待验收”。

本轮再次收口：完整运行时回归达到 187 个测试文件、746 个测试全部通过；旧 sidecar approval/renderer-tool IPC 改为 runtime 命名，删除指向已移除 Worker 的无效测试 mock，移出旧的未跟踪 `dist-staged-*` 构建目录。类型检查、Lint、格式检查、核心 CI、生产构建和 `out` 产物扫描再次通过。

本轮新增收口：Cron 定时触发、手动运行、取消和运行状态查询均固定走 TS 执行器，删除旧 Cron 执行器、条件选择器和遗留资格判断源码；手动运行不再重复推进触发计数。运行时回归当前为 187 个测试文件、746 个测试全部通过。

本轮继续收口：渠道 IPC 的项目、会话、消息、模型绑定及级联删除路径已移除 `requestNativeDb` 与旧读兼容分支，统一通过同一 TS `BusinessRepository`；类型检查、核心 CI、运行时全量测试、构建产物扫描和 legacy artifact 扫描再次通过。该变更仍不替代全量契约、真实主站、Electron E2E 和六平台发布证据。

本轮再收口：删除 Renderer 旧 Agent stream attach/reattach、旧 session sidecar run registry、旧 Sidecar debug/approval 命名及 App 启动时的旧恢复调用；窗口恢复现在只读取 TS Runtime journal/snapshot。同步更新 preload 门禁以验证现行 TS Runtime 路径，核心 CI 与 187/746 运行时回归再次通过。

本轮共享协议清理：删除无引用的旧 Agent stream batcher/receiver/codec 与 .NET runtime contract，将仍在业务 loop 使用的调试类型迁移到 TS loop 类型；生产构建、TS Runtime 资产门禁、legacy artifact 扫描和全量运行时测试均通过。

本轮文档与维护入口清理：README、安装/构建/故障排查文档、CODE_WIKI 和 Agent 维护模板已改为 TypeScript/WASM runtime 命令与架构，不再指向已删除的 `codegraph:publish`、Native Worker 项目或 .NET 构建步骤；历史迁移日志保留旧实现描述，仅作为审计记录。

本轮质量门禁修复：删除 Renderer 会话切换中旧可见性通知清理后遗留的空分支，修正迁移生产边界、TS 业务读适配器和 Agent bridge 的格式问题；`npm run lint:ci`、类型检查、188/751 运行时测试和生产边界验证均通过。

本轮继续收口：数据库读取 canary 已改为直接复用 TS `BusinessRepository`，移除读取环境开关、旧读取 Worker 回退和 `legacy-read-worker.mjs` 的构建/打包资产；旧读取测试夹具已移出，后续读路径证据统一以 TS 仓库集成测试为准。`verify-runtime-main-assets` 与旧产物扫描通过。

CodeGraph 复核：`web-tree-sitter` 已升级至 `0.25.10`，与现有 `tree-sitter-wasms@0.1.13` ABI 兼容；18/18 语言 grammar（含 Ruby、Dart、Haskell、Julia、Razor）已通过 WASM 加载、固定语料解析和工作区索引测试。Haskell/Julia/Razor 资产已固定在 `resources/codegraph/grammars`，来源 pin 与 SHA-256 见同目录 `NOTICE.md`。本轮新增 `codegraph-special-grammars.acceptance.test.ts`，覆盖三种语言的声明／引用索引、工作区增量改写／删除和三文件性能预算；但这只是特殊语言专项证据，18 语言完整语义对照、增量、跨文件和同环境性能门禁仍未齐备，因此 P7 保持“实现中”。

本轮 CodeGraph 全语言收口：新增 `codegraph-all-grammars.acceptance.test.ts`，对台账中的 18 个语言标识执行固定语料无解析错误、声明/引用提取、全量工作区增量改写与删除，以及统一 15 秒性能预算；同时修复 PHP、Ruby、Bash 的 AST 节点映射。该测试 20/20 通过，18 个 CodeGraph 语言条目已按证据规则标为“通过”；跨文件语义深度和平台性能外部证据仍不替代六平台发布验收。

本轮状态契约修复：`codegraph:status` 改为从当前 TS/WASM 18 语言矩阵动态计算可用与缺失项，移除旧的 24/19/5 硬编码；请求校验错误也改为指向 TS CodeGraph service。新增状态契约测试 1/1 通过，避免桌面诊断页继续显示过时的 Worker 状态。

本轮工作区残留清理：发现并移出未跟踪的旧 `cli/dist` 生成目录（其中含 `native-worker-client.js` 和 `ola-worker-runtime.js`），保留副本于 `/tmp/ola-legacy-cli-dist-20260920` 供恢复审计；当前 CLI 生产入口仍是 `scripts/run-ts-runtime-cli.mjs` 与 TS runtime。

本轮用户内容路由收口：补齐 `commands:ensure` 与 `prompts:ensure` 的 Main TS IPC 注册，新增 commands/prompts 的注册、MessagePack 编解码、列表/加载、创建/保存、路径越界和缺失资源测试；commands 7 条与 prompts 3 条路由中共 10 条已按台账证据规则标为“通过”。

本轮配置存储路由收口：补齐 Config 与 Settings 的整根 `read/write`、键 `get/set/delete` TS IPC 入口，保留原子临时文件替换和串行写入；新增 2 个端到端契约场景覆盖整根读写、键删除、空键失败和落盘结果。Config 5 条与 Settings 5 条路由共 10 条已按证据规则标为“通过”。

本轮运行时任务路由收口：新增 `runtime:jobs-submit/get/list/state/cancel/events/reap-stale` 的 Main TS IPC 入口，统一经 `BusinessRepository` 和工作区授权校验，覆盖任务生命周期与跨工作区拒绝；`runtime-job-ipc.test.ts` 的 2 项契约测试通过。7 条 runtime jobs 路由已按台账证据规则标为“通过”，严格台账进度更新为 45/376；其余全量 Agent、渠道、UI／浏览器、真实主站和六平台证据仍未关闭。

本轮 Souls 路由收口：`souls:builtin-list`、`market-list`、`categories`、`download-remote`、`get-target-paths` 和 `install` 全部由 Main TS handler 注册并通过 MessagePack 契约测试；测试同时修复了无参 MessagePack `null` 在 categories/target-paths 上的生产边界缺陷。6 条 Souls 路由按实现、生产路径、旧路径清除和契约/E2E 证据规则标为“通过”，严格台账进度更新为 51/376。

本轮 Skills 入口补齐：补上 `skills:ensure-builtins` 和 `skills:resolve-path` 两个原台账入口的显式 Main TS 注册，新增 MessagePack 契约测试覆盖初始化和路径不存在错误；2 条 Skills 路由已按证据规则标为“通过”，严格台账进度更新为 53/376。

本轮最终回归：全量 runtime 回归为 195 个测试文件、780 个测试全部通过；类型检查、CI lint、生产构建、TS runtime 生产边界、Main 资产检查、旧 Worker/.NET 产物扫描和 `git diff --check` 均通过。严格退出门禁仍拒绝，当前校验器输出为 75/376，仍有 321 项验收项未关闭。

本轮 CodeGraph 请求面收口：TS/WASM `TsCodeGraphService` 补齐 `db-smoke`、`instructions`、`tools-list`、`prompt-context` 和 `node`，并覆盖 22 个历史 CodeGraph 请求入口的索引、查询、关系、统计、同步、项目管理和状态契约；专项测试 2/2 通过，22 条路由按证据规则标为“通过”，严格台账进度更新为 75/376。

本轮 Agent 内容入口收口：Main TS `AgentCatalog` IPC 覆盖 ensure、list、load、manage-list、manage-read、manage-save，新增真实目录复制、MessagePack、修改落盘和路径越界测试；6 条 agents 路由按证据规则标为“通过”，严格台账进度更新为 81/376。

本轮 Extension 路径入口收口：新增 `extension:resolve-path` Main TS IPC 路由，复用 ExtensionService 的安全路径约束并覆盖已安装/缺失扩展契约；该路由按证据规则标为“通过”，严格台账进度更新为 82/376。全量 runtime 回归当前为 197 个测试文件、782 个测试全部通过；本轮重跑的类型检查、CI lint、生产构建、TS 生产边界、Main 资产和 legacy artifact 扫描均通过，严格退出仍报告 314 项验收项未关闭。

本轮 Desktop Flow 数据入口收口：现行 Main `desktop-flow-handlers.ts` 已由 TS `BusinessRepository` 作为唯一权威持久化路径，专项 workspace/取消/replay 测试覆盖列表、保存、删除、运行开始/完成和运行列表；对应 6 条历史 `db/desktop-flow-*` 路由按证据规则标为“通过”，严格台账进度更新为 88/376。

本轮 Draw runs 数据入口收口：`db-handlers.ts` 的 list/save/delete/clear 四个 MessagePack 入口均通过 workspace-scoped TS DAO 与 BusinessRepository canary，新增 IPC 测试确认四路由参数和调用边界；4 条 draw-runs 路由按证据规则标为“通过”，严格台账进度更新为 92/376。

本轮 Goal 生命周期收口：目标 list/get/create/set/update/clear/account 及事件 add/list 均通过 workspace/session 授权和 TS DAO，新增 13 项 IPC 测试覆盖状态变更、用量记账与事件日志；9 条 goals/goal-events 路由按证据规则标为“通过”，严格台账进度更新为 101/376。

本轮项目／计划／任务数据入口收口：补充 `db-ipc-message-scope.test.ts` 覆盖 Projects 6 条、Plans 6 条、Tasks 7 条的完整列表、查询、创建、更新、删除及 session 级操作；生产入口均经 `db-handlers.ts` workspace/session 授权后调用对应 TS DAO。专项测试 14/14 通过，严格台账进度更新为 121/376，剩余旧链路、真实主站、Electron E2E 和六平台发布证据仍未关闭。

本轮回归结果：全量 runtime 回归为 197 个测试文件、788 个测试全部通过；`typecheck`、`typecheck:runtime`、`lint`、`build` 和台账结构校验通过。严格退出校验仍失败，因此不退出目标。

本轮会话数据入口收口：补充会话 list/get/create/update/delete/clear-all 的 workspace-scoped IPC 契约测试，覆盖消息回读和生命周期通知边界；6 条 sessions 路由按 TS DAO、生产路径和双重测试证据标为“通过”，严格台账进度更新为 127/376。严格退出校验仍有 269 项验收项未关闭。

本轮消息数据入口收口：补充消息 list/list-user/markers/locator/page/request-context/window/search 以及 add、batch、artifacts、upsert、update、clear、delete、replace、truncate、count 的 TS DAO 契约测试；严格台账进度更新为 145/376，严格退出校验仍有 251 项验收项未关闭。

本轮会话行为入口验收：已有 BusinessRepository SQLite 集成证据覆盖 session-status、session-usage-stats、messages-compact-session、session-reset-conversation 的跨 workspace 隔离、统计、压缩和重置；四条此前“待验收”路由补齐为“通过”，严格台账进度更新为 149/376，严格退出校验仍有 247 项验收项未关闭。

本轮 Cron 数据接管验收：`cron-dao.ts` 的任务创建、更新、查询、启停、软／硬删除、触发计数、启动恢复，以及运行创建、查询、更新、详情、日志和消息替换均已具备 TS `BusinessRepository` 生产路径；结合 Cron workspace 切换与数据库接管集成证据，16 条 Cron 数据路由标为“通过”，严格台账进度更新为 165/376，严格退出校验仍有 231 项验收项未关闭。

本轮 Agent changes 数据接管验收：文件变更追加、查询、会话列表、撤销、状态重算和已完成变更清理均通过 `agent-changes-dao.ts` 与 `agent-change-handlers.ts` 的 TS 路径；数据库接管集成和 workspace 撤销测试证据齐备，6 条路由标为“通过”，严格台账进度更新为 171/376，严格退出校验仍有 225 项验收项未关闭。

本轮 Wiki 数据入口验收：Wiki 查询和生成后的持久化均经过 workspace 授权与 TS `capability-dao.ts`，补充生成保存契约测试 3/3 通过；`db/wiki-get` 与 `db/wiki-save` 两条路由标为“通过”，严格台账进度更新为 173/376，严格退出校验仍有 223 项验收项未关闭。

本轮同步数据入口验收：`sync-engine.ts` 已通过 `sync-dao.ts` 调用 TS `BusinessRepository` 完成快照捕获、合并应用和 metadata 保存；新增 TS DAO 契约测试 2/2 通过，3 条 `db/sync-*` 路由标为“通过”，严格台账进度更新为 176/376，严格退出校验仍有 220 项验收项未关闭。

本轮文件同步入口验收：`workspace-sync-run.ts` 与 `sync-handlers.ts` 覆盖工作区同步快照、合并应用、远端确认、删除与提交；数据库接管集成测试验证全量 workspace-owned business slice 和授权边界，3 条 `sync/files-*` 路由标为“通过”，严格台账进度更新为 179/376，严格退出校验仍有 217 项验收项未关闭。

本轮 QQ 唤醒数据接管验收：QQ 入站源消息记录、唤醒资格查询和发送去重均经 `qq-wakeup-dao.ts` 与 TS `BusinessRepository`，并覆盖 workspace 授权和渠道调用；专项 DAO 测试 1/1 通过，3 条路由标为“通过”，严格台账进度更新为 182/376，严格退出校验仍有 214 项验收项未关闭。

本轮 SSH 数据入口验收：SSH 分组与连接的 list/get/create/update/delete 全部经 `ssh-dao.ts` 调用 TS `BusinessRepository`，新增 DAO 契约测试 1/1 通过；9 条 SSH 数据路由标为“通过”，严格台账进度更新为 191/376，严格退出校验仍有 205 项验收项未关闭。

本轮渠道插件会话接管验收：插件会话创建、按插件查询、按外部聊天查询、全量查询、消息读取、清空、删除和重命名均由 `channel-handlers.ts` 调用 TS `BusinessRepository`；新增真实 SQLite 生命周期测试 1/1 通过，8 条路由标为“通过”，严格台账进度更新为 199/376，严格退出校验仍有 197 项验收项未关闭。

本轮插件关联数据入口验收：普通项目查询与插件数据清理通过真实 SQLite BusinessRepository 场景验证，并由渠道生产 handler 调用；新增场景测试保持通过，`db/plugin-normal-projects` 与 `db/plugin-remove-data` 两条路由标为“通过”，严格台账进度更新为 201/376，严格退出校验仍有 195 项验收项未关闭。

本轮 Usage 数据入口验收：真实 SQLite 场景覆盖 usage event 写入、workspace 聚合查询及历史数据维护清理；`db/usage-add-event`、`db/usage-query`、`db/usage-maintenance` 三条路由标为“通过”，严格台账进度更新为 204/376，严格退出校验仍有 192 项验收项未关闭。

本轮 sub-agent history 数据入口验收：历史索引、分页读取、写入、替换以及迁移标记/状态均由 `sub-agent-history-dao.ts` 经 TS IPC handler 接管；既有历史数据契约测试与新增真实 SQLite 迁移状态测试通过，6 条路由标为“通过”，严格台账进度更新为 210/376，严格退出校验仍有 186 项验收项未关闭。全量 runtime 回归为 203 个测试文件、796 个测试全部通过。

本轮 Skills 数据与文件入口验收：Skill 的导入、清理、删除、内置同步、列表、文件列表、加载、市场查询/下载、读取、保存和扫描均由 Main TS handler 提供；新增真实 IPC 生命周期/故障边界测试，专项 4/4 通过，全量 runtime 回归为 203 个测试文件、797 个测试全部通过。12 条路由标为“通过”，严格台账进度更新为 222/376，严格退出校验仍有 174 项验收项未关闭。

本轮 Extension IPC 入口验收：扩展列表、安装、更新、删除、资源读取、路径/目录操作、工具执行和 storage CRUD 均通过 Main TS handler；Extension IPC 与服务层专项 5 个测试文件、9 个测试通过，8 条路由标为“通过”，严格台账进度更新为 230/376，严格退出校验仍有 166 项验收项未关闭。

本轮 MCP 配置入口验收：新增 `mcp:get` 并统一由 Main `McpConfigStore`/`mcp-handlers.ts` 提供配置列表、读取、添加、更新和删除；真实 MessagePack IPC、可信发送者拒绝、并发 JSON 存储测试通过，5 条路由标为“通过”，严格台账进度更新为 235/376，严格退出校验仍有 161 项验收项未关闭。

本轮 Terminal 入口验收：终端创建、列表、读取、输入、调整尺寸、结束及全部结束均由 Main `terminal-handlers.ts`/`TerminalSessionManager` 接管；补充 workspace 授权和可信窗口 IPC 测试，专项 2 个测试文件、3 个测试通过，7 条路由标为“通过”，严格台账进度更新为 242/376，严格退出校验仍有 154 项验收项未关闭。

本轮 Web 入口验收：`web:search`、`web:fetch` 及搜索配置/提供商查询均由 Main `web-search-handlers.ts` 接管；新增离线安全分支、参数错误和秘密状态 IPC 测试，并与 WebFetch/WebSearch 服务测试共同通过，2 条路由标为“通过”，严格台账进度更新为 244/376，严格退出校验仍有 152 项验收项未关闭。

本轮 Agent changes 入口验收：变更列表、hydrated/diff 内容和本地回滚均由 `agent-change-handlers.ts` 及 TS DAO 接管；workspace 撤销、文件恢复和授权撤销期间不泄露快照测试通过，4 条路由标为“通过”，严格台账进度更新为 249/376，严格退出校验仍有 147 项验收项未关闭。

本轮图片生成入口验收：`openai-images/generate` 对应 Main `image-generation-handlers.ts`，非法请求门禁测试通过并确认不再进入旧 Worker；严格台账进度更新计入 1 条路由。

本轮 Team Runtime 入口验收：团队运行时创建、删除、消息追加、消息消费、快照、成员更新和 manifest 更新均由 `team-runtime-handlers.ts`/`TeamRuntimeStore` 接管；新增 workspace 授权 IPC 契约测试，与 Store/工具测试共同通过，7 条路由标为“通过”，严格台账进度更新为 256/376，严格退出校验仍有 140 项验收项未关闭。

本轮 FS 入口验收：本地文件读写、二进制读写、目录列表/创建、移动/删除、文档读取、glob、文件名搜索和 grep 均经 `fs-handlers.ts` 的 TS 文件服务处理；新增真实临时目录 IPC 契约及不可信发送者拒绝测试，14 条路由标为“通过”，严格台账进度更新为 270/376，严格退出校验仍有 126 项验收项未关闭。

本轮 Extension 执行入口收口：新增 `extension:execute-tool` Main TS IPC 适配，运行时配置只从 Main ExtensionService 注入，复用声明式 HTTP 工具的网络白名单、输入和响应限制；与 `extension:resolve-path` 共同通过 Extension IPC 契约测试。全量 runtime 回归为 197 个测试文件、784 个测试全部通过；类型检查、CI lint、生产构建、TS 生产边界、Main 资产和 legacy artifact 扫描均通过。严格退出校验器当前为 102/376，仍有 294 项验收项未关闭。

本轮资源哈希（SHA-256）：

| 资产                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `tree-sitter-haskell.wasm` | `faeadc9de27c4b40fc7221fc683b62b69feb7976c8ce194442c136fb608ee9c5` |
| `tree-sitter-julia.wasm`   | `f9d6aff11d7c53d80afe57deaf44bc87a6aef8f09a8b192c16d3722bc368b412` |
| `tree-sitter-razor.wasm`   | `3d9a20a7e4b1b6599e0a23ea758ec6bd9207c03a0a88944b4ddaac24ad96152a` |

发布一致性复核：`package.json`/lock 的 1.0.5 已与 `electron-builder.yml` 的 Windows `buildVersion: 1.0.5.0` 对齐；Haskell/Julia grammar 资源已通过非仓库 cwd 加载测试，且未新增 Node 或 .NET 运行时依赖。

本轮桌面自动化收口：`desktop-flow:list`、`runs-list`、`save`、`delete`、`sync` 和 replay 审计统一使用 TS `BusinessRepository` 持久化入口，不再合并本地 JSON 第二存储或在 TS 失败时回退；旧 renderer 的 `sync` IPC 仅保留兼容响应且为 TS 权威 no-op。补充修复 replay 审计收尾失败时活动 token 未清理的问题，确保保存、删除和 replay 不会被残留状态误阻断。桌面流 IPC 聚焦测试 21/21、全量 runtime 188/751、类型检查、Lint、核心 CI 和构建均通过；真实桌面 E2E、跨平台安装升级和外部主站证据仍未完成。

静态审计结果：`src/main`、Renderer、Runtime 和 Preload 中没有指向 `native-worker`、`native-agent-runtime`、`sidecar-manager`、`run-agent-via-sidecar` 或 `codegraph-worker` 的生产导入，也没有 `agentBridge.request(...)` 的生产调用；构建与发布脚本不再设置 `OLA_NATIVE_WORKER_RID`。退出门禁仍因台账证据未齐而失败，这是预期行为。

## 阻断项

1. `src/main` 与 Renderer 仍有历史兼容命名和协议类型；本轮已移除可达的旧 Worker 请求/启动路径，但媒体新路由仍需真实模型联调和端到端证据。
2. CodeGraph 已从生产构建、开发启动、CI 和发布准备中移除 .NET 路径；18/18 grammar 已接管，仍需完成 18 语言语义对照、增量、跨文件和性能门禁。
3. 完整旧新契约、数据库全部领域、UI／浏览器 Electron 端到端及性能门禁未取得最终证据。
4. 未在本轮完成真实主站个人／团队模型联调，或 Windows、Linux、macOS 的 x64/arm64 六平台原生安装、升级、启动、签名／公证验收。当前本机结果不能替代这些证据。

下一批实施应按[补充验收基准](SUPPLEMENTAL-ACCEPTANCE.md)逐项替换生产入口并更新台账。最终严格门禁须在删除旧实现、完成真实联调和六平台验收后通过。

本轮 Git 迁移收口：本地 Git 查询、执行、扫描和详细状态均由 Main/TS host 提供；远程 Git 命令由 `ssh2` 连接和 TS 参数映射执行，不再请求 Native Worker。新增 `git-remote-ts-contract.test.ts` 覆盖命令转义、远程操作映射和 porcelain 状态解析，并修复远程 `??` 文件重复归类问题。6 条 Git 路由标为“通过”，严格台账进度更新为 276/376；Agent、渠道、SSH 文件操作、六平台发布和真实联调仍未完成。

本轮运行时心跳收口：旧 `worker/ping` 的生产等价能力已由 `RuntimeServer` 的认证 TS `ping` 协议提供，桌面运行时和传输测试覆盖版本响应、认证和断线重连；旧 Worker 心跳入口不再作为生产调用路径。严格台账进度更新为 277/376。

本轮 Shell 执行收口：`shell:exec` 与 `shell:abort` 已由 Main `shell-handlers.ts` 和 TS `local-shell-executor.ts` 接管，覆盖输出限制、超时、取消、工作目录和参数校验；2 条 Shell 路由标为“通过”，严格台账进度更新为 279/376。

本轮数据库启动收口：`db/initialize` 的生产实现已确认只通过 `database.ts` 调用 TS `BusinessRepository` canary；新增成功、TS 仓库不可用时 fail-closed 的隔离测试，严格台账进度更新为 280/376。

本轮 Agent 核心运行入口收口：历史 `agent/active-runs`、`cancel`、`compress-context`、`run`、`run-snapshot`、`run-status` 已对应到受保护的 TS Runtime IPC/RuntimeServer，并由 workspace、取消、快照和压缩测试提供证据；6 条路由标为“通过”，严格台账进度更新为 286/376。调试正文读取、反向请求、会话可见性和工具结果查询仍保持未完成状态。

本轮最终本机回归：全量 runtime 为 210 个测试文件、807 个测试通过；`typecheck`、`lint`、`format:check`、`git diff --check` 和 `npm run build` 均通过。Vite 仅输出动态导入分包提示，无构建错误；严格退出仍因 107 项未关闭而拒绝。

本轮 QQ 渠道会话收口：QQ 会话保存、加载、清理由 Main `QqSessionFileStore` 接管，采用 workspace/plugin 哈希隔离、原子写入、过期拒绝和 0600 文件权限；新增文件存储、唤醒 DAO 和入站源消息测试，3 条路由标为“通过”，严格台账进度更新为 289/376。

本轮 Memory 数据入口收口：记忆自动化记录/撤销/去重、记忆根、任务、Stage-1 输出、引用记录和根清理共 17 条 DAO 路由均通过 TS `BusinessRepository`；新增聚合契约测试确认所有入口在 TS writer 可用时不会进入旧 route guard，严格台账进度更新为 306/376。

本轮渠道配置收口：旧 `channel/config-*` 六条入口统一映射到 Main `plugin:list/add/update/remove` 与 `ChannelConfigFileStore`，覆盖 workspace 隔离、精确 ID、原子写入和配置读写；专项渠道存储/工作区测试 7 项通过，严格台账进度更新为 312/376。

本轮插件关联数据收口：插件会话路由、模型/项目同步及按插件项目查找/创建共 5 条入口均确认由 `BusinessRepository` 和 Main Channel handler 提供，workspace 归属测试通过，严格台账进度更新为 317/376。

本轮 Wiki/消息尾部入口收口：新增受信任窗口 + workspace 校验的 `wiki:delete` Main TS IPC，并为 `db/messages-delete-last` 增加 TS repository fail-closed 契约测试；严格台账进度更新为 318/376。

本轮运行时生命周期收口：`capabilities/check`、`initialize`、`ping`、`shutdown` 已由认证 TS Runtime/desktop runtime 生命周期提供；传输能力协商、版本心跳、启动和停止测试通过，严格台账进度更新为 322/376。

本轮 SSH 配置面收口：连接/分组 CRUD、OpenSSH host 解析、配置快照、原子写入和导入导出共 13 条入口由 TS DAO/config store 提供；专项 SSH 配置、workspace、导入导出测试 18 项通过。SSH 远程命令、SFTP 文件传输和跨连接复制仍未标记通过，严格台账进度更新为 335/376。

本轮音频与 SSH 导入收口：`openai-audio/speech`、`openai-audio/transcribe` 已由 Main `pet-handlers.ts` 的 TS fetch/multipart 实现覆盖；SSH import preview/apply 已由 TS transfer service 覆盖。请求形状和导入契约测试通过，严格台账进度更新为 339/376。

本轮快速本机验收：补记 `db/messages-delete-last` 的 TS repository 生产路径与契约证据，严格台账更新为 340/376。全量 runtime 回归为 214 个测试文件、814 个测试全部通过；`npm run build`、`verify:ci-core`、`verify:legacy-artifacts`、无 .NET 产物测试、类型检查、Lint、格式检查和 `git diff --check` 均通过。严格退出门禁仍拒绝，当前为 340/376，尚有 56 项阶段、未完成能力或外部发布证据未关闭，因此本轮不创建 `main-ts` 分支、不提交 Git。

本轮 Agent 调度器收口：旧 `request-stop`、`reverse-cancel`、`reverse-response` 入口统一映射到 TS Runtime 的 `run.cancel`/`run.interact`，新增授权、工作区隔离和响应契约测试；`agent/tool-results-lookup` 新增 Main TS IPC 与 BusinessRepository 持久化查询，并覆盖失败关闭。全量 runtime 回归为 215 个测试文件、818 个测试全部通过，严格台账更新为 344/376，严格退出仍有 52 项未关闭。

本轮 Agent 数据与调试收口：`agent/append-messages` 通过 Main TS message DAO 追加并校验会话工作区；会话可见性由 TS registry 管理；调试正文由 TS renderer debug store/data ref 读取，不再抛出旧 Worker 不可用错误。新增 5 项契约测试，严格台账更新为 347/376；严格退出仍有 49 项未关闭。

本轮系统诊断与 SSH 命令收口：`worker/memory`、`worker/routes` 改由 TS Runtime/Main 返回进程内存和运行时能力矩阵；SSH `exec` 已由 `ssh2` Main 实现并由 TS SSH Agent 工具调用。全量 runtime 回归为 217 个测试文件、824 个测试全部通过，严格台账更新为 350/376，严格退出仍有 46 项未关闭；SSH SFTP 全量操作和跨平台/真实主站证据仍未宣称通过。

本轮 SSH 工具面收口：SSH Main/Agent 路径移除 `NativeSsh` 命名，Read/Write/LS/Glob/Grep 五个 SFTP 工具补齐授权和调用契约测试；全量 runtime 回归为 217 个测试文件、825 个测试全部通过，严格台账更新为 355/376，严格退出仍有 41 项未关闭。剩余 SSH 二进制/传输/取消/连接测试仍需更深的远端证据。

本轮 SSH SFTP 基础操作收口：二进制读写、stat、目录创建、删除和移动统一复用 TS SFTP 原语并增加契约测试；全量 runtime 回归为 218 个测试文件、827 个测试全部通过，严格台账更新为 361/376，严格退出仍有 35 项未关闭。剩余项集中在远端传输/取消、阶段验收、六平台发布和真实主站联调。

本轮 SSH 传输最终收口：上传/下载/远程复制的扫描、取消别名、SFTP 原语和连接测试统一由 TS Main handler 提供；修复下载续传偏移重复截取问题，新增扫描契约。全量 runtime 回归为 218 个测试文件、830 个测试全部通过；台账路由/语言验收更新为 376/376，严格退出仍有 20 个阶段、六平台发布和真实主站证据项未关闭。

本轮跨平台构建收口：为发布 staging 脚本补充显式 `--x64`/`--arm64` 架构选择，成功生成 macOS x64/arm64、Linux x64/arm64、Windows x64/arm64 六个解包目录；六份证据均通过遗留 Worker/.NET 资产扫描。macOS 当前缺 Developer ID，Windows/Linux 当前缺原生机器安装、启动、升级和签名验证，因此六个目标均记录为“受外部条件阻塞”。

本轮阶段台账收口：P0、P2、P3、P4、P5、P6、P7 的对应 CLI/桌面/工作区/Agent/调度器/业务路由/CodeGraph 证据已补齐并标记“通过”；P1、P8–P12 保留未通过，分别对应 Electron 全量 E2E/视觉、真实数据库停写恢复、工作台与功能页、浏览器人工流程、真实主站和平台发布门禁。

本轮旧回退路径清理：CLI/Main Runtime 改为从 `workspace-tools` 接入 TS 工具，删除未被生产调用的 Native Desktop Flow reconciliation 及其旧测试；Shell 和本地 Grep 不再暴露 `native_aot` 或启动备用运行时，Renderer 内存诊断移除 `nativeWorker` 数据契约。数据库停写、备份、TS 独占写入和隔离恢复演练证据复核通过，P8 更新为“通过”。全量 runtime 回归为 217 个测试文件、825 个测试全部通过，严格退出仍有 12 项外部/UI 证据未关闭。

本轮工作台与浏览器阶段收口：标签顺序/裁剪/跨空间清理、布局恢复、对话分屏、多窗口工作区注册与事件隔离，以及 Main 浏览器 host/guest 生命周期、控制权、分区、Profile 和 WebContentsView 导航安全测试均已复核；P9、P11 更新为“通过”。P1 仍保留完整 Electron E2E/视觉基线，P10 仍保留全部功能页面人工验收。

本轮加速本地验收：修复 Electron 冷启动 IPC 注册竞态，将首屏可能并发请求的 Agent、Extension、Skills、Sub-agent、渠道、Cron、浏览器、媒体、更新器等 Main TS handler 提前到创建窗口前注册；源码开发态更新器不再读取不存在的 `out/main/dev-app-update.yml`，渠道业务停写期间的预期 `CHANNEL_HANDOVER_QUIESCED` 不再误报为错误。真实 Electron 冷启动通过，Renderer 成功加载且未出现未注册 IPC、未捕获异常、启动失败或 .NET/Native Worker 错误。`npm run build`、`npm run lint`、`npm run typecheck`、`npm run format:check`、`npm run verify:ci-core`、`npm run verify:legacy-artifacts` 全部通过；全量 runtime 为 217 个测试文件、825 个测试通过。验收台账仍为 376/376 条路由/语言项通过，但严格退出仍保留 10 项开放证据：P1、P10、P12、真实主站联调及六平台原生安装/升级/启动/签名；因此尚未创建 `main-ts` 分支或提交 Git。

本轮 Electron 验收固化：新增 `npm run verify:electron-startup`，在干净 userData 目录中启动编译后的 Electron Main，通过 CDP 验证标题、Renderer URL、React root 和首屏内容，并保存启动日志与截图。脚本通过，截图显示本地个人空间、工作台、项目列表和新建对话首屏；该证据补强 P1 的本地 E2E/视觉基线，但不替代全量功能页、跨平台人工验收。

本轮启动竞态再验证：脚本首次发现 `window:workspace:set`、`app:global-memory-home` 和 `input-draft:read` 在首屏并发请求时仍存在晚注册窗口；已将窗口控制、应用目录/系统信息、宠物和输入草稿 handler 一并前置到创建窗口前。修复后 `npm run verify:electron-startup` 通过，日志无未注册 handler、未捕获异常、旧 Worker 或 CodeGraph 关键词；改动后的 `npm run test:runtime` 为 217/825 全通过，`npm run verify:ci-core`、`npm run build`、Lint、格式检查和 `git diff --check` 通过。

本轮页面级 smoke 扩展：Electron CDP 脚本现依次打开 22 个 Settings registry 页面、Usage 与 Pet Studio，共 24 个页面路由，逐页检查 React root 和有效内容；补齐浏览器 register/unregister-tab 的 MessagePack 路由，桌面自动化在工作区尚未登记或离线时返回安全空状态而不产生未处理异常。24/24 路由通过，启动日志无 IPC 未注册、未捕获异常、旧 Worker 或 CodeGraph 错误；桌面流/浏览器专项测试 44/44 通过。P10 仍不能标为通过，因为完整既有功能页人工流程、输入法、多窗口和跨平台视觉验收尚未完成。

本轮文档一致性清理：更新 `AGENTS.md`、`CLAUDE.md`、`README.zh.md` 和本迁移记录的当前状态段，明确 TS Runtime/BusinessRepository/TS-WASM 是生产权威，旧 Worker/.NET 仅作为历史记录，不再描述为当前回退或构建依赖；同步把阶段表更新为台账当前状态。质量门禁 `lint`、`format:check`、`git diff --check` 和台账校验通过。

本轮 macOS 发布复核：基于当前 TS 构建重新生成 macOS arm64 unpacked staging，822 个文件通过遗留 Worker/.NET 资产扫描，`codesign --verify --deep --strict` 证明 bundle 完整；由于本机没有 Developer ID，`spctl --assess` 明确拒绝 adhoc 签名。该结果补强构建/产物证据，但签名、公证、安装升级和 Windows/Linux 原生验收仍按规则保持开放。

本轮最终本机回归：发现并修复数据库 MessagePack handler 晚于窗口创建注册的启动竞态；最新 `npm run build` 后 `npm run verify:electron-startup` 通过，24 个页面路由和首屏加载均通过，日志无未注册 IPC。`npm run test:runtime` 为 217 个测试文件、825 个测试全部通过；`verify:ci-core`、类型检查、Lint、格式检查、生产边界和旧产物扫描全部通过。严格退出门禁仍明确保留 P1、P10、P12、真实主站联调及六平台安装/升级/启动/签名证据，不能提前标记完成。

本轮全量 Vitest 复核：`npm test` 通过 217 个测试文件、825 个测试；新增 TS/WASM CodeGraph、运行时边界、Electron 启动竞态修复和 CodeGraph 服务命名清理均未引入回归。严格退出门禁状态不变：本地自动化证据已通过，外部平台与真实主站证据仍开放。

本轮页面验收脚本强化：`verify-electron-startup.mjs` 不再手工复制 Settings 路由，而是从当前 `SETTINGS_REGISTRY` 自动生成 22 个设置页面，再加 Usage 与 Pet Studio，共 24/24 路由通过；后续新增设置页面会自动进入启动 smoke，避免验收清单漂移。

本轮 Go 服务全量复核：在 `server/` 执行 `go test ./...` 和 `go vet ./...` 均通过；同时对 CI、启动、发布脚本和生产资源清单执行旧 `.NET`/Native Worker/sidecar 关键字扫描，无命中。该证据补齐服务端质量门禁，但不替代真实主站部署联调。

本轮六平台 staging 复核：当前 Windows x64/arm64、Linux x64/arm64、macOS x64/arm64 解包目录全部通过 `verify-runtime-staging.mjs`；对应 642/642/629/629/822/822 个文件均通过遗留 Worker/.NET 资产扫描。六个平台的原生安装、升级、启动和签名证据仍按验收规则保持开放。

本轮签名政策与 macOS 验收更新：按用户明确要求，本轮 macOS/Windows 暂不要求签名证书，已登记签名豁免；在临时安装目录对 macOS x64/arm64 解包应用分别完成安装、替换升级和启动保持运行验证，并补入对应台账证据。Windows/Linux 原生安装、升级、启动及真实版本升级证据仍未具备，因此严格退出仍不能改写为 376/376。
