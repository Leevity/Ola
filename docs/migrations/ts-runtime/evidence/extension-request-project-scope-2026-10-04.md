# Extension 请求项目作用域与撤销验收（2026-10-04）

平台：Windows x64，Ola 1.0.5 原生安装版 `C:\tmp\ola-release-current-20261004ww\Ola.exe`。隔离发布脚本生成 NSIS 和 ZIP 并通过内置校验；NSIS SHA-256 为 `FFDB11F9040E2E3275D4035C922416E2537F8B534B9978EDB2D7E820DC761CB4`。以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004ww` 安装到新目录，退出码 0。

发现 `getActiveExtensionIds(null)` 错误回退到界面当前项目，可能使显式全局会话继承前台项目的 Extension。同时，编程会话的请求工具定义取自前台项目的全局注册表，后台项目会话可能缺失自己的 Extension 或获得不属于自己的定义。现区分省略参数与显式 `null`，并在每次请求中按目标会话项目重建声明式 HTTP Extension 工具定义。主进程仍按运行快照中的 Extension ID 和启用状态构建实际执行工具。

`extension-store-project-scope.test.ts` 验证全局与项目作用域隔离、项目 B 请求替换项目 A 的旧工具定义；相关 Extension 测试、类型检查和 lint 通过。源码与上述原生安装版 `pending-session-queue-electron.test.ts` 各 1/1 通过：项目会话的真实 Provider 请求包含已启用的 `extension__e2e-view__fixture`，通过主进程禁用扩展后，下一次请求不再包含该工具。该流程同时回归 Skill、SubAgent 的新增与移除，以及既有会话、任务和结果操作。

未验证 Extension 管理 UI 的完整启停流程、真实 HTTP Extension 调用和产物索引、后台项目窗口同时执行、真实远程 Provider 或主站联调；M1 I13、M2 扩展结果来源、P1/P10 与 Windows x64 发布目标继续开放。
