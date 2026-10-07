# 资源列表故障提示与重试（2026-10-04）

验收发现资源页列表请求失败时，原状态把错误写入与详情共用的 `error` 字段；空列表选择清理随即清除该错误，页面最终误显示“没有可用资源”。

现在列表错误独立保存在 `listError`，页面显示本地化“资源加载失败”和“重试”。一次性故障注入仅在带标记的隔离 E2E 数据目录生效：首次 `commands:manage-list` 请求失败，点击“重试”后两类资源重新加载。源码真实 Electron 用例 2/2 通过，失败态[截图](resources-list-failure-source-2026-10-04.png)已人工查看，未出现误导性的空列表提示。`npm run build`、`npm run typecheck:runtime`、定向 ESLint 与 Prettier 检查通过。

此项只验证资源列表加载错误及恢复，P10 所要求的全部功能页、输入法、多窗口和平台矩阵仍未完成。

最新 Windows x64 候选包 NSIS SHA-256 `4346ECB4E4CB82785771C32F6BE49A673276627C9F94EF829D4CD16EA9F60636`。解包版两条资源页流程 2/2 通过；以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004tt` 安装到新目录，退出码 0，安装版两条流程 2/2 通过。[安装版失败态截图](resources-list-failure-installed-2026-10-04.png)已人工查看。安装目录隔离启动 `passed: true`，运行时资源完整性通过；旧 Worker/.NET 扫描覆盖 733 个解包文件及 5197 个 ASAR 条目，未发现遗留资产。官方旧版升级与真实旧版数据连续性仍需另行验收。
