# 插件页短窗口信息层级和滚动补验

日期：2026-10-04。范围：P10，简体中文，源码与 Windows x64 安装版隔离 Electron；短窗口使用 760×560 的 150% 等效视口，宽窗口使用 1100×700 视口。全部测试使用带标记的临时数据根。

## 问题与处理

原插件页将能力健康、生命周期和插件表单依次放在固定高度的多层滚动布局里。短窗口中摘要占去大半空间，插件表单只剩很小的内部滚动区域。修复后，短窗口把健康与生命周期合并到可展开概览入口，默认把空间留给插件设置；插件内容改由设置页外层滚动。插件标签在窄宽度下排成两列，避免新露出的标签超出视口。宽窗口继续直接展示健康、生命周期及原有插件面板滚动布局。

## 验证

- `settings-save-failure-electron.test.ts` 的 22 页窄视口巡检在源码与安装版各 1/1 通过，无文档级横向溢出、可见控件越界或已渲染正文小于 12px。
- 同一流程确认短窗口概览默认收起，按钮可展开和收起；插件面板高度大于 200px，插件内容不再使用内部纵向滚动；图片插件模型来源、服务商、模型选择框可操作。1100×700 宽窗口中概览直接可见，插件内部滚动保持原行为。
- [安装版插件首屏](../../../../analysis/audits/2026-10-03-settings-visual/after-capability-compact-installed/12-settings-page.png)显示概览入口和两列插件标签；[安装版下方表单](../../../../analysis/audits/2026-10-03-settings-visual/after-capability-compact-installed/23-plugin-model-override.png)显示三项模型配置可在页面滚动后完整阅读。源码截图在相邻的 `after-capability-compact-source/` 文件夹。
- `npm run build`、定向 ESLint、`npm run verify:settings-visual` 通过。精简发布暂存生成的 NSIS 安装包 SHA-256 为 `C010BA7A8719FC573CDCDAA948EBDF27011859C0E28C3CEE29B7F2294BF9BC28`，以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004tt`，退出码 0；隔离启动 `passed: true`。733 个解包文件与 5197 个 ASAR 条目扫描未发现旧 Worker/.NET 资产。

本项仍是等效窄视口，不代表真实 Windows 显示缩放、读屏朗读或各语言长文案验收。P10 保持“实现中”。
