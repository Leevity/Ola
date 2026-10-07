# 动态 SubAgent 请求快照验收（2026-10-04）

平台：Windows x64，Ola 1.0.5 原生安装版 `C:\tmp\ola-release-current-20261004vv\Ola.exe`。安装包 `dist-staged-win-x64/ola-1.0.5-setup.exe` SHA-256 为 `8545DF01F267CD20C2285A26D4C36E385315E2ECBE96E26D0046F6D7EF58F49B`。安装命令使用 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004vv`，退出码 0。模型端点是隔离的本地 OpenAI 兼容 SSE 夹具。

检查发现主进程 TS Runtime 的 `Task` 原先只提供任意字符串 `subagent_type`，并用通用提示词执行子任务，没有读取 `~/.ola/agents`。现每次运行从主进程 AgentCatalog 读取目录快照，模型请求中的 `Task.subagent_type.enum` 反映当前 Agent 名称；执行时应用所选 Agent 的提示词、工具允许/禁止列表及最大轮数，未知类型拒绝。子任务工具范围仍与父运行的显式工具快照取交集。

在同一 Electron 进程中，端到端流程写入合法 `e2e-dynamic-agent.md` 后通过真实编程会话发送消息，下一次 Provider 请求包含该名称；删除文件后再发送消息，下一次请求不再包含该名称。同一测试还验证 Skill 的新增与移除。源码版和上述原生安装版 `pending-session-queue-electron.test.ts` 各 1/1 通过（安装版约 40 秒）。`sub-agent-runtime-tool.test.ts` 4/4 通过，验证自定义提示词、工具范围、轮数与未知类型拒绝；`npm run build` 通过，隔离发布脚本退出 0。

此证据不包含管理 UI 增删 Agent、真实模型选择并调用自定义 Agent、Extension 动态 schema、真实远程 Provider 或主站联调。M1 I13、P1/P10 与 Windows x64 发布目标继续开放。
