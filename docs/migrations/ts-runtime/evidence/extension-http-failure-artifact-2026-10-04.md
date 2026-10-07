# Extension HTTP 失败产物边界（2026-10-04）

问题：声明式 HTTP Extension 的 4xx/5xx 响应以前返回 `data.ok=false`，但 Runtime `tool.result` 未标记 `isError`；若错误正文恰好含声明的链接字段，仍会登记 `artifact.registered`，使失败产物出现在结果索引。

修复：HTTP 生产者仅在成功响应时提取声明的链接；ToolExecutor 将 `__olaExtensionResult` 且 `data.ok=false` 的结果标为错误，并在登记链接前再次拒绝失败响应。错误结果原文仍保留在工具结果中，供会话查看，不进入产物索引。

验证：`extension-artifact-http-flow.test.ts` 使用本机实际 HTTP 服务，以同一扩展分别返回 200 和 503；200 只登记一条经声明确认的链接，503 的 `tool.result.isError=true` 且没有 `artifact.registered`。同一测试把真实工具事件写入 RunJournal，关闭并重开数据库后仅能查询到成功链接；其他空间查询为空且不能隐藏该链接；本空间隐藏后再次重开仍不出现在索引中，原始事件仍保留。`extension-http-tool.test.ts` 和 `tool-artifact-events.test.ts` 分别覆盖生产者与事件边界。四个相关测试文件共 15 项通过，`npm run typecheck:runtime` 与完整 `npm run build` 通过。

此项证明声明式 HTTP 链接的成功/失败、RunJournal 重启查询、空间隔离及隐藏索引边界。尚需原生安装版真实工具调用、结果中心 UI 查询和复用、真实远程服务以及其他来源的验收；M2、P10 保持开放。
