# 任务看板键盘焦点与中文选项补验（2026-10-03）

`TaskBoardPage` 的任务卡片、列表行、排期行和看板状态下拉框补充明确的 `focus-visible` 焦点环；任务详情标题输入框与状态下拉框补充可访问名称。详情优先级选项改用现有 `layout:taskBoard.priority.*` 翻译，避免中文界面仍显示 `low/medium/high/urgent`。

源码生产构建、Web/Runtime 类型检查、定向 ESLint 与 Prettier 检查通过。`pending-session-queue-electron.test.ts` 的源码版完整 Electron 流程 1/1 通过；用例检查详情输入控件名称、当前语言的优先级选项，并通过键盘 Tab 后检查任务行匹配 `:focus-visible` 且实际计算样式存在焦点环。用例使用带标记的临时数据根，未配置截图输出。

同一源码以 staging 生成 Windows x64 NSIS 安装包，SHA-256 为 `C200DA9EF99A59D7A32D2B8849B36E110CA8F0BE131CBCC7E48ABC5F901DC027`；用 `/S /CURRENTUSER` 安装到隔离目录 `C:\tmp\ola-release-current-20261003j`，退出码 0。指向该安装版的完整 Electron 流程 1/1 通过，包含上述键盘焦点及详情控件检查。发布产物扫描 718 个解包文件与 5177 个 ASAR 条目，未发现旧 Worker/.NET 运行时；安装包签名状态为 `NotSigned`，沿用已记录的用户豁免。

此轮 Electron 运行采用测试环境的当前语言，没有分别切换中英文完整流程；中文优先级文案已在语言资源中核对。实际操作系统缩放下的字体观感、截图视觉对照及全功能页键盘走查仍开放；本证据只补强 P10/W9 的局部路径。
