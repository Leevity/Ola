# 设置页标签与说明目标检查

日期：2026-10-04。范围：P10，22 个系统设置子页，简体中文、源码与 Windows x64 安装版隔离 Electron；760×560 的 150% 等效视口。数据根为带标记的临时目录。

新增逐页 DOM 断言，检查设置内容区域内所有已渲染元素的 `aria-labelledby` 和 `aria-describedby` 引用是否指向存在的元素。初次运行准确发现“插件”和“自定义插件”两页的外层 `section` 都引用不存在的 `capability-center-title`。共用 `SettingsPageHeader` 现支持可选标题 ID，能力中心把此 ID 赋给实际可见的 h2。

修复后源码与新 Windows x64 安装版 `settings-save-failure-electron.test.ts` 各 1/1 通过；[源码检查结果](../../../../analysis/audits/2026-10-03-settings-visual/semantic-target-audit.json)和[安装版检查结果](../../../../analysis/audits/2026-10-03-settings-visual/semantic-target-audit-installed.json)均为 22 页、0 个缺失引用。该流程还继续覆盖各页基础布局、插件与频道键盘操作、CodeGraph 索引、设置写盘拒绝后的重试与重启读取。`npm run build`、定向 ESLint 与设置视觉契约通过。

精简发布暂存生成的 NSIS 安装包 SHA-256 为 `4C2BFC076C9427429BAA506548ACCB836D8AD2233C8787001E6A22BCD02FCAC0`，以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004vv`，退出码 0；隔离启动 `passed: true`。扫描 733 个解包文件及 5197 个 ASAR 条目，未发现旧 Worker/.NET 资产。

检查覆盖的是逐页已挂载的设置 DOM，不包括未打开的弹窗、下拉层或运行中才出现的错误状态；存在引用也不能替代读屏朗读和名称质量审查。P10 继续“实现中”。
