# FinalOutcome 会话绑定验收（2026-10-04）

## 问题与修复

工具运行后的模型摘要曾以 `final-outcome:<随机 ID>` 启动 TS Runtime。该 ID 没有对应业务会话，Main 的工作区授权拒绝运行并报 `SESSION_WORKSPACE_MISMATCH`，最终只能退回固定文案。

现在两个入口（前台聊天与渠道自动回复）都把原业务会话 ID 和工作区 ID 传给摘要；摘要只允许一轮、不授予工具。模型来源仍由原 Provider 绑定，运行授权使用业务会话所属工作区。

## 验收证据

- `tests/runtime/final-outcome-session-binding.test.ts`：验证摘要请求使用业务会话和工作区，并得到模型生成的结果。
- `tests/runtime/final-outcome-artifacts.test.ts`：验证固定文案回退和文件证据过滤。
- `tests/runtime/pending-session-queue-electron.test.ts`：源码版 Electron 流程确认摘要请求实际送达本地模型服务，且 Main 日志不再出现 `SESSION_WORKSPACE_MISMATCH`。
- 命令：`npx vitest run tests/runtime/final-outcome-artifacts.test.ts tests/runtime/final-outcome-session-binding.test.ts`，3/3 通过；`npm run build` 通过；`RUN_PENDING_QUEUE_ELECTRON_E2E=1 npx vitest run tests/runtime/pending-session-queue-electron.test.ts`，1/1 通过。

此次验证限本地模拟模型服务与源码版 Electron。真实远端模型、安装版升级及跨平台仍按迁移台账的未完成项验收。
