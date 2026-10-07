# Extension HTTP 工具到结果页桌面闭环（2026-10-04）

平台：Windows x64，Ola 1.0.5 原生安装版 `C:\tmp\ola-release-current-20261004xx\Ola.exe`。从当前构建通过隔离发布脚本生成 NSIS 与 ZIP，内置 staging 校验通过；NSIS SHA-256 为 `5CEA9A6F1C22DDE1E80DB4DE7B79D42EEEA3B4BB7FB0E6F89F224B9A9044F26B`。以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004xx` 安装到新目录，退出码 0。

在带标记的隔离 Ola 目录中安装声明式只读 HTTP Extension，并将网络权限限定为本机测试服务。用户通过真实编程会话输入框发送两条标记消息；本地 OpenAI 兼容 SSE 模型端点分别返回 `extension__e2e-view__report_ok` 与 `report_fail` 工具调用。前者从本机服务获得 200 与声明的链接，后者获得 503 且错误正文也含链接。应用的 `execution-artifacts:list` 查询仅返回成功链接；结果中心页面显示“E2E extension report”，不显示失败链接；点击“打开来源会话”返回原会话。随后停用 Extension，下一次模型请求不再提供它的工具 schema。

最新源码版与上述原生安装版 `pending-session-queue-electron.test.ts` 各 1/1 通过（新增重启断言后安装版约 43 秒）。同一测试在工具调用后关闭桌面进程，以同一隔离数据目录再次启动；`execution-artifacts:list` 和可见结果页面均仍显示成功链接，不显示失败链接。既有工作区、会话、任务看板与结果流程同测通过。另有本机 HTTP + RunJournal 集成测试证明跨空间不可读和隐藏索引持久。

此证据覆盖可控本地服务的真实工具执行、结果页和桌面进程重启查询。尚需真实远程 Extension 服务、文件/媒体等其他来源、复用动作，以及 macOS/Linux/ARM 安装验收；M2、P10 与 Windows x64 发布目标继续开放。
