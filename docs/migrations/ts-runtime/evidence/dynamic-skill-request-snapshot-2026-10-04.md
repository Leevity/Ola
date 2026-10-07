# 动态 Skill 请求快照验收（2026-10-04）

平台：Windows x64，Ola 1.0.5 原生安装版 `C:\tmp\ola-release-current-20261004uu\Ola.exe`。安装包 SHA-256 `C8E9F19C9F014D770208B6A8973973E8DD14E18A31413C67B942C0A1484AD4A8`。用带标记的隔离 Ola 数据目录和本地 OpenAI 兼容 SSE 夹具，不联系真实模型服务。

在应用启动并完成现有工作区、会话和结果流程后，测试在隔离目录写入合法的 `e2e-dynamic-skill/SKILL.md`。报告模板的请求按设计禁用工具，因此该请求只验证模板执行，不作为动态工具证据。随后进入既有编程会话，通过真实输入框发送消息；本地模型端点收到请求，`Skill` 工具参数 `SkillName.enum` 包含新 Skill。待响应显示后，测试移除该 Skill 的 `SKILL.md`，再次通过输入框发送消息；下一次模型请求的 `SkillName.enum` 已不包含该名称。

`RUN_PENDING_QUEUE_ELECTRON_E2E=1` 且 `OLA_PACKAGED_EXE` 指向上述安装版时，`tests/runtime/pending-session-queue-electron.test.ts` 1/1 通过（约 38 秒）。此证据证明同一 Electron 进程内文件目录新增、移除 Skill 后，后续编程会话的真实 Provider 请求使用最新的 Skill schema。它不证明 Skill 管理 UI 的安装/删除动作、SubAgent 或 Extension 的动态 schema、模型实际调用 Skill、真实远程 Provider 或主站联调；M1 I13、P1/P10 继续开放。
