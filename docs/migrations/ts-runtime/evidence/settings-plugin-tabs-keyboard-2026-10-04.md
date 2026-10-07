# 插件标签键盘与中文说明补验

日期：2026-10-04。范围：P10，插件设置页，简体中文、源码和 Windows x64 安装版隔离 Electron；使用 760×560 的 150% 等效视口与 1100×700 宽视口，不读取真实 `~/.ola`。

内层图片、浏览器、Product Design、项目智能标签原来声明了 `role="tab"`，但全部进入 Tab 顺序，不能用方向键切换，也未声明与内容区的关系。现在只让当前标签进入 Tab 顺序，支持 ArrowLeft/ArrowRight 和 Home/End 切换，焦点随选中状态移动；每个标签指向同一内容区，内容区反向引用当前标签。中文概览说明把通用的 Extension、Skills 改为“自定义扩展”“技能”，MCP 保留协议名称并补“服务器”。

`settings-save-failure-electron.test.ts` 在源码和新 Windows x64 安装版各 1/1 通过：先检查四个内层标签只有一个可 Tab 聚焦、选中标签与内容区相互关联；真实键盘 ArrowRight 切换到浏览器插件并移动焦点，Home 返回图片插件；继续执行窄窗概览、模型选择、外层标签键盘切换、22 页布局巡检及设置保存故障恢复。安装版[插件页截图](../../../../analysis/audits/2026-10-03-settings-visual/after-plugin-tab-keyboard-installed/12-settings-page.png)已复核。`npm run build`、定向 ESLint、`npm run verify:settings-visual` 和非严格 `npm run verify:i18n` 通过；其他 14 种语言仍各有 79 个英文回退键。

精简发布暂存生成的 NSIS 安装包 SHA-256 为 `A6330A0F5ED3F27F0656AE777BCB16C9145F7DEC40965ECC02ACE3AC654B5603`，以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004uu`，退出码 0；隔离启动 `passed: true`。扫描 733 个解包文件和 5197 个 ASAR 条目，未发现旧 Worker/.NET 资产。

本项是 DOM 键盘与语义断言，不替代 Windows 读屏软件朗读、真实显示缩放、其他语言长文案及插件实际服务调用验收。P10 保持“实现中”。
