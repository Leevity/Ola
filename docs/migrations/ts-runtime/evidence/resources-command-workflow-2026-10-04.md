# 资源页命令流程验收（2026-10-04）

在隔离的 Ola 数据目录中，使用真实 Electron Renderer 和 Main IPC 完成以下操作：

1. 从工作台“扩展功能”进入资源页，检查中文分类、当前工作模式和搜索框名称。
2. 打开“新增命令”，输入非法名称，确认收到中文校验提示；随后创建 `release-check-e2e`。
3. 在资源编辑器填写正文并保存，读取数据目录下的 `commands/release-check-e2e.md`，确认内容落盘。
4. 退出并以同一隔离数据目录重启 Electron，重新进入资源页，确认命令仍在列表且正文可预览。

验证命令：`RUN_RESOURCES_COMMAND_ELECTRON_E2E=1 npx vitest run tests/runtime/resources-command-electron.test.ts --reporter=verbose`。Windows PowerShell 中通过设置同名环境变量运行，结果为 1/1 通过。`npm run build`、`npm run typecheck:runtime` 和定向 ESLint 通过。

同一流程在本轮新建的 Windows x64 解包版和原生安装版各 1/1 通过。NSIS SHA-256 为 `743977F787A10785C3269324AA2B01B2B2D121263BA88FAC556B1623138461C5`，使用 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004ss` 安装，退出码 0。安装版隔离进程启动检查 `passed: true`，运行时资源完整性通过；旧 Worker/.NET 资产扫描覆盖 733 个解包文件和 5197 个 ASAR 条目，未发现遗留运行资产。[安装版资源页重启后截图](resources-command-installed-2026-10-04.png)经人工查看，中文分类与命令正文均正常显示；[启动截图](electron-packaged-startup-2026-10-04T02-28-36-713Z.png)记录了隔离启动时的引导页。

资源页同时修正了中英混用的分类、工作模式和副标题；返回、搜索、创建表单、编辑、预览和保存控件补充了可访问名称。该证据只覆盖资源页的用户命令流程，不能替代 P10 所需的全部既有功能页、输入法和多窗口验收；P10 状态保持开放。
