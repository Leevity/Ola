# 场景模板只读执行策略（2026-10-03）

## 实现边界

项目审查与 SSH 巡检模板在准备提示词时附带场景类型。发送时创建的会话将 `scenario_policy` 写入 TS BusinessRepository；schema v12 为旧库添加可空列，历史会话保持普通权限。该字段创建后不可经会话更新接口移除，重启加载和会话复制均保留。

Renderer 在工具目录和请求快照阶段仅暴露对应的文件读取、列目录、Glob、Grep 工具。Main 在每次创建 Runtime 工具执行器时重新读取持久化会话策略；如果请求包含其他工具名，或本地目录、SSH 连接和远程目录与该会话记录不一致，拒绝运行。项目审查不接受 SSH 工具，SSH 巡检不接受 Bash、写文件或任意 MCP/扩展工具。Main 的工具选择与批准交互仍按现有机制运行，批准不能放宽场景策略。

## 本地验证

- 临时 SQLite 新库和旧库测试覆盖 schema v12 补列、精确迁移清单、策略重启后保留、跨工作区不可见、非法值和策略更新拒绝。
- 策略测试覆盖本地只读工具、写工具拒绝、目录替换拒绝、SSH 连接替换拒绝与命令工具拒绝。
- 相关 3 个测试文件 72 项通过；全量 Runtime 回归 258 个文件通过、2 个跳过，1045 项通过、13 项跳过。
- `npm run typecheck`、`npm run typecheck:runtime`、完整 `npm run build`、定向 ESLint、`git diff --check`、`verify:ts-migration-ledger` 通过。
- 完整 `npm run verify:ci-core` 通过。对数据库中意外出现的未知策略值增加拒绝分支，并通过定向策略测试及 Main 类型检查。
- Main 在运行提交授权及工具执行器创建时都会重新读取会话策略。新增带 `.ola-e2e-root` 标记的临时数据目录集成用例：创建持久化只读会话，提交包含 `Write` 的运行，`run.submit` 在模型调用前返回 `SCENARIO_TOOL_FORBIDDEN`。Renderer 在该策略下也不向模型注入项目渠道、MCP、Team、桌面控制或图像插件上下文；工具白名单测试确认这些工具名均被排除。策略测试文件现为 5/5 通过；未启动真实 Provider，也未触及用户数据目录。
- 上述 Renderer 上下文调整后，`typecheck:web`、完整 `verify:ci-core` 和正常 PTY 中的完整 `npm run build` 再次通过。将构建输出重定向到文件会触发本机 Electron Vite `process.stdout.moveCursor` 错误；正常终端构建退出码为 0。
- 隔离 Runtime 集成用例继续执行 `stop`、关闭 BusinessRepository、重新启动 Runtime，再对同一会话提交 `Write`，仍收到 `SCENARIO_TOOL_FORBIDDEN`；策略测试 5/5、定向 ESLint 与格式检查通过。中文/英文权限说明已改为准确的“仅开放读取工具”，`verify:i18n` 和 `verify:product-experience` 通过。

## 仍需验收

还未在可见 Electron 界面中把三个模板各执行一次真实 Provider 路径，也未实机演练会话续跑、队列与完整应用重启后的工具请求；上述重启测试只覆盖隔离 Main Runtime 和数据库。SSH 路径限制的代码级验证见下文，真实服务器、并发路径变化和软链接边界仍需专项实机证据。当前不得把代码级限制等同于 S4 全部验收。严格 TS 迁移退出检查仍有 10 项开放。

## 第三个模板与旁路复核

资料报告模板现在也写入持久化的 `materials-no-tools` 策略；它可以不绑定项目，但 Main 拒绝该会话请求任何工具，隔离 Runtime 停止并重启后仍拒绝。Renderer 的工具快照为空，不为该模板加载项目/全局记忆，也不为无项目资料报告创建默认工作目录。所有带场景策略的会话跳过自定义 Hooks、自动记忆写入和 MCP 状态刷新，避免工具白名单之外的间接副作用；Main 不实例化其 Skill、MCP 或扩展工具。普通会话沿用原逻辑。

Main 的 `hooks:emit` IPC 也按已注册窗口工作区读取持久化会话策略；即使当前 Renderer 没有该会话的内存状态，受限场景仍不会运行 Hook。普通会话仍执行 Hook，窗口未注册工作区时拒绝。`scenario-hooks-ipc.test.ts` 2 项通过，最终代码的 `npm run typecheck` 与 `npm run build` 通过。

后续检查发现不存在或不属于该窗口工作区的会话仍可进入 Hook 服务。现在发送流程在触发 `sessionStart` 前等待会话创建写入，Main 对缺失会话返回 `HOOK_SESSION_WORKSPACE_MISMATCH`。新增跨工作区回归后 `scenario-hooks-ipc.test.ts` 为 3 项通过；与策略/创建顺序专项共 10 项通过。最终代码的 `npm run build`、定向 ESLint 和全量 `npm run test:runtime` 均通过：259 个文件通过、2 个跳过，1051 项通过、13 项跳过。

项目路径再核对：`hooks:list`、`hooks:trust` 现在接收会话 ID，由 Main 在当前窗口工作区读取会话的本地目录；`hooks:emit` 也覆盖 Renderer 传来的路径，仅使用持久化会话目录。SSH 会话不将远端目录当成本机 Hook 目录。`scenario-hooks-ipc.test.ts` 5 项通过。最终代码的完整构建、核心 CI、定向 ESLint 和全量 Runtime 通过：259 个文件通过、2 个跳过，1053 项通过、13 项跳过。当前 `HooksService` 的 `AUTOMATION_HOOKS_ENABLED` 为 `false`，所以本项证明 IPC 路径约束和将来启用时的防线，不代表 Hook 执行功能已可用。

## SSH 巡检目录读取边界

在带 `ssh-read-only` 策略的运行中，Main 把已绑定的远程工作目录传给 `Read`、`LS`、`Glob`、`Grep` 的 SFTP 操作。读取前在同一 SFTP 会话中对根目录和请求路径做 `realpath`，仅接受根目录及其子路径；相邻前缀、绝对目录外路径、`..` 逃逸和指向目录外的软链接均拒绝。Scoped Glob/Grep 遍历时跳过软链接项，避免 Grep 再次读取目录外内容。普通 SSH 工具调用保留原路径语义。

回归同时暴露原 SSH Glob 的 `**/*` 表达式不能匹配正常文件，使 Grep 搜索候选为空；已修正并用假 SFTP 的目录/软链接用例覆盖。`ssh-scenario-scope.test.ts`、`ssh-runtime-tools.test.ts`、`ssh-sftp-contract.test.ts` 共 13 项通过；最终代码的 `npm run typecheck`、`npm run build`、`verify:ci-core`、定向 ESLint 与全量 Runtime 通过：260 个文件通过、2 个跳过，1057 项通过、13 项跳过。尚无真实 SSH 服务器或并发远端文件系统修改下的端到端证据；SFTP `realpath` 与后续读取间仍存在远端路径被并发替换的时间窗，不宣称对恶意远端主机的强隔离。

最终代码的全量 `npm run test:runtime` 退出码为 0：259 个文件通过、2 个跳过，1050 项通过、13 项跳过。Windows `node-pty` 在过程中输出一次 `AttachConsole failed` 子进程日志，但测试最终通过；这条日志仍需在终端相关验收中单独复核，不用本次全量通过推断终端实机行为。

本轮 `scenario-tool-policy.test.ts` 与 `scenario-preflight.test.ts` 共 18 项通过，`ts-runtime-session-create-order.test.ts` 与策略测试共 7 项通过。最终代码的 `npm run typecheck`、`npm run typecheck:runtime`、`npm run build`、完整 `verify:ci-core`、`verify:i18n`、`verify:product-experience` 和相关文件 ESLint 通过。此验证尚未证明可见 Electron 资料报告界面的真实模型输出，也未证明第三方 Provider 自身不执行额外处理。

SSH 路径预检补充：明显越出所选根目录的 `..` 或绝对路径，现在在远端 `realpath` 查询前拒绝，避免先探测目录外目标。根目录若是软链接，仍接受该配置别名下的绝对路径，再以规范路径做最终边界检查。三个 SSH 专项文件 14 项、`typecheck:node` 和定向 ESLint 通过。该改动不消除远端目录在预检与读取之间被并发替换的风险，真实 SSH 主机验收继续开放。
