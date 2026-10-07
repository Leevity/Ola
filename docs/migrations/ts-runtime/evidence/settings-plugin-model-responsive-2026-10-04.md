# 插件模型配置窄窗与名称补验

日期：2026-10-04。范围：简体中文、源码与 Windows x64 安装版隔离 Electron、760×560 的 150% 等效视口。测试使用临时数据根，不读取真实 `~/.ola`。

插件页图片模型来源、服务商和模型选择框原来固定为 320px。窄窗时卡片内容不足 320px，选择框会超出卡片；服务商和模型的文字标题也未成为选择框的可访问名称。现改为 `w-full max-w-80`，并为三个选择框及插件启用开关补充中文可访问名称。

`settings-save-failure-electron.test.ts` 在真实插件页打开“为插件单独指定模型”，断言三个选择框均有可见宽度且未超出父容器，并核对开关和选择框名称。源码与安装版流程各 1/1 通过；[源码截图](../../../../analysis/audits/2026-10-03-settings-visual/after-plugin-model-responsive/23-plugin-model-override.png)和[安装版截图](../../../../analysis/audits/2026-10-03-settings-visual/after-plugin-model-responsive-installed/23-plugin-model-override.png)已人工复核。`npm run build`、定向 ESLint 和 `npm run verify:settings-visual` 通过。视觉契约允许桌面自动化页使用既有 `SettingsSectionCard` 与 `SettingsSafetyNotice` 的紧凑首屏布局，避免把这项已验收布局误判为缺失通用面板。

精简发布暂存生成的 NSIS 安装包 SHA-256 为 `5C3AD5B71093A37EB36922410ADB2ADA0B35269B18C2C07CC1962C9994C8981E`；以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004ss`，退出码 0。安装版隔离启动 `passed: true`；扫描 733 个解包文件和 5197 个 ASAR 条目，未发现旧 Worker/.NET 资产。直接从整个开发目录执行 electron-builder 会在 4GB 和 8GB Node 堆上限处耗尽内存；改用仓库现有精简暂存流程完成本次发布产物。

本项只证明源码和 Windows 安装版等效窄视口与这些控件的布局、名称及选择操作。截图还显示：能力摘要和生命周期卡占据窄窗上半部，插件内容区首屏仅露出少量表单，需要在嵌套滚动区继续向下找控件；这属于后续 P10 信息层级调整项，不能因本轮宽度断言通过而关闭。真实 Windows 显示缩放、读屏朗读及其他插件配置状态仍待验收；P10 保持“实现中”。

后续已通过[短窗口信息层级补验](settings-capability-compact-2026-10-04.md)调整概览和滚动容器；本段保留当时截图发现的问题。
