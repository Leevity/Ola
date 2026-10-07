# 任务日历中文与可访问名称补验（2026-10-04）

范围：功能改造计划 W9/P10 的任务与自动化首页。此前 Windows x64 安装版简体中文首屏仍把任务看板入口显示为 `Board`；月份翻页、日期格和三个筛选控件缺少明确的可访问名称。

实现：任务看板入口使用中英文资源；翻月按钮提供名称；日期按钮包含完整本地日期与当日任务数、当前选中状态及可见焦点样式；状态、会话、工作目录筛选提供用途名称。增加 en/zh 文案，其他 14 个语言仍由 i18n 回退机制显示英文。

证据：`npm run typecheck`、定向 ESLint、`npm run verify:i18n` 和完整 `npm run build` 通过。源码版 `top-level-pages-electron.test.ts` 1/1：从工作台侧栏打开“任务与自动化”，确认任务看板中文按钮、月份按钮与日期格名称、三项筛选名称；实际翻到上个月再返回；日期按钮可聚焦，点击后 `aria-pressed` 更新；既有一级页面、模型切换与 22 个设置子页流程继续通过。[源码首屏](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/source/01-tasks.png)已人工复核，按钮显示“任务看板”。

Windows x64 NSIS 安装包 SHA-256 为 `33DFFFEEA032A461BFF650BD21A4165905358E539052CC9981C1D06F9ED9CD37`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004jj` 安装，退出码 0。同包一级页面 Electron 流程 1/1 通过；[安装版任务日历首屏](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/01-tasks.png)已人工复核。隔离启动 `passed: true`，运行时 staging 完整性通过；扫描 738 个解包文件和 5197 个 ASAR 条目，无旧 Worker 运行资产。

边界：DevTools 合成 Enter 没有触发原生日期按钮的默认点击，不能据此推断真实键盘成功或失败；这条不可靠断言未保留。真实键盘与读屏走查、任务实际执行/投递及其他语言质量仍开放。
