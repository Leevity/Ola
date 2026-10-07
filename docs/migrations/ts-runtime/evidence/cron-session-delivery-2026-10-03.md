# Cron 会话投递持久化证据（2026-10-03）

## 问题与改动

原先 `deliveryMode: 'session'` 依赖渲染窗口收到 `cron:run-finished` 后写会话消息。目标窗口未打开时无法保证投递，多个窗口同时处理时也可能重复写入。现在由主进程在运行结束后调用 TS BusinessRepository，一次事务写入会话消息、会话计数与 `cron_run_deliveries` 结果。渲染进程只响应 `cron:session-delivered` 重新加载消息。

投递键由运行 ID 决定；同一运行并发触发时只保存一条消息与一条投递结果。目标会话不存在或不属于工作区时记录失败，不写入其他工作区。试运行不投递。schema v11 扩展投递种类为 `session`，迁移保留已有投递行。

启动时先恢复 Cron 任务状态，再扫描 schema v11 安装后已结束、尚无会话投递记录的运行并补投。扫描按运行 ID 分页，单条失败会记录错误并继续后续运行；后续启动可再次尝试。历史运行不自动回填，避免旧版本已在窗口中显示的结果被重复投递。配置为“无投递”时，即使旧渠道绑定仍在，也不会向运行时暴露渠道发送工具或上下文。

## 本地验证

- `npx vitest run tests/runtime/cron-session-delivery.test.ts tests/runtime/business-schema-legacy-columns.test.ts tests/runtime/ts-cron-agent-background.test.ts`：3 个文件、16 项通过，包括使用真实临时库模拟运行结果已保存、会话投递未发生时的两次启动恢复；失效目标记为失败，后续有效目标仍投递，最终仅产生一条消息与一次刷新事件。
- `npm run typecheck`、`npm run typecheck:runtime`：通过。
- `npm run build`：通过（含 Electron 主进程、预加载、渲染进程和 TS runtime 构建）。
- 新增代码的定向 ESLint：通过。
- 恢复扫描的候选查询验证了“结束且未投递”会出现、成功和失败记录落库后不再出现；无投递携带旧渠道绑定的回归通过。

## 尚未签收

数据库事务与代码契约已验证；下文补充了安装版应用进程重启后的会话补投。Electron 多窗口可见刷新、模型执行中强制终止后的恢复，以及飞书、钉钉等外部渠道实际送达仍未验收。外部渠道的未知结果、连续运行及去重仍按 S5 验收矩阵保持开放。

## 隔离安装版进程重启补验

新增 `tests/runtime/cron-session-recovery-electron.test.ts`，只有显式设置 `OLA_PACKAGED_EXE` 时才运行，避免常规测试触碰真实用户目录。本机使用 SHA-256 为 `6C45D8A6DE730D107603981BC902913EB1DDE79198A6CD06AA0F251FE2E2C64B` 的 Windows x64 安装包对应可执行文件，命令为 `OLA_PACKAGED_EXE=C:\tmp\ola-release-current-20261003c\Ola.exe npx vitest run tests/runtime/cron-session-recovery-electron.test.ts`（PowerShell 中先设置同名环境变量）。测试先用带 `.ola-e2e-root` 标记的临时数据根启动并停止安装版，再用 BusinessRepository 在该库写入已完成、未投递的运行，随后真实启动安装版两次。最终数据库只有一条 `cron-session-electron-recovery-run` 消息，待投递查询为空。实测 1/1 通过；`typecheck:runtime`、定向 ESLint 通过。测试结束清理了核验过路径的临时根，没有访问真实 `~/.ola`。

该流程证明安装版启动链路会恢复已有的待投递会话运行，且下一次启动不会重复写入；它没有在模型执行中强制结束进程，也没有走查多窗口可见刷新或任何外部渠道送达。因此上文这些剩余事项继续开放。

## 桌面通知结果准确性补查

发现 `showSystemNotification` 原先吞掉构造/显示异常，Runtime `Notify` 工具仍固定返回 `success: true`，会把未确认或失败的桌面投递记成成功。现等待 Electron `show`/`failed` 事件，2 秒内没有确认则标记 `unknown`；同步失败和不支持通知时标记 `failed`。短时间重复通知被抑制时也不声称本次已显示。Cron 工具结果对矛盾字段保留 `unknown`，`isError` 不再被成功字段覆盖。通知日志不再输出标题和正文。事件、工具和分类专项共 19 项通过，`typecheck:node`、`typecheck:runtime`、定向 ESLint 与完整 `npm run build` 通过。操作系统实际通知送达及外部渠道联调仍待验收；上述安装包生成于本次源码变化之前，不能当作最新发布候选包。

同一源码随后运行 `npm run test:runtime`，退出码 0：263 个测试文件通过、3 个跳过；1079 项测试通过、14 项跳过。此结果是全量 Runtime 回归，不代表操作系统实际通知送达或外部渠道验收。

在通知与 SSH 改动后重新构建并安装 Windows x64 包，安装包 SHA-256 为 `ECAA0A11BE057F4447B3D1AD88E2E6E6B142049FDE89822E4EC07972CF2F41AA`。指向该最新安装版重新执行 `cron-session-recovery-electron.test.ts`，1/1 通过。先前“安装包早于源码”的限制已解除；真实通知与外部渠道验收仍开放。

队列恢复顺序的 Renderer 修复后再次重打并安装 Windows x64 包，当前 SHA-256 为 `DF138216AA0BC51A7CA9A06110E849B56F18669DA68DBCF41022BC14FCC0FB97`；对当前安装版重跑同一 Cron 会话补投用例，1/1 通过。上述上一版哈希仅保留作历史证据。

最后一次 Renderer 错误分类细化后，新安装包 SHA-256 为 `DC867250B503FE78C8C4AEFE88E86A85244A5CDAA3AE81B7EC8E8AC7B2789647`；对该包再次运行 Cron 会话补投用例，1/1 通过。此前两版哈希均为过程记录。
