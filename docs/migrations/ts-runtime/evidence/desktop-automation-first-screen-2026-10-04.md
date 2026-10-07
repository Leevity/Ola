# 桌面自动化首屏操作与失败反馈（2026-10-04）

范围：W9/P10，简体中文设置页，Windows x64。此前 760×560 截图中安全提示与两段重复说明占据首屏，流程名称输入框位于底部，“开始录制”需要下滚。[旧版截图](../../../../analysis/audits/2026-10-03-settings-visual/installed-current/10-settings-page.png)保留原貌。

录制卡片现在使用更紧凑的纵向间距，移除与页面副标题重复的卡片说明；安全提示保持在录制操作之前。流程名称使用与输入框关联的 `label` 和说明。桌面流程读取失败不再静默显示空列表，而是显示错误和重试入口；录制、停止保存、单独保存、重放、取消与删除的 IPC 失败显示本地化提示。

源码与新安装版 `top-level-pages-electron.test.ts` 各 1/1 通过：760×560 视口文档宽 760px；“开始录制”按钮 y=342.9–378.9，宽 116px；安全提示完整位于首屏；流程名称标签关联输入框。[源码截图](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/source/10-desktop-automation-compact.png)、[安装版截图](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/10-desktop-automation-compact.png)和[安装版几何数据](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/10-desktop-automation-compact-layout.json)已保存。完整源码构建、类型检查、定向 ESLint 与 i18n 审查通过。

Windows x64 NSIS 安装包 SHA-256 `39B6C02DA2DCC096981A0F75E58BF051038B3E885688A48600C2D9E24430321A`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004mm` 安装，退出码 0。安装版隔离启动返回 `passed: true`；运行时 staging 完整性检查通过；旧 Worker/.NET 资产扫描覆盖 738 个解包文件和 5197 个 ASAR 条目，无遗留资产。

边界：本轮验证了首屏几何和正常读取；后续已完成读取/保存故障的可见恢复验收，见[桌面流程保存恢复证据](desktop-automation-save-recovery-2026-10-04.md)。其他操作失败、真实系统 150% 缩放、读屏朗读和 macOS/Linux 仍待验收。P10 与正式发布台账状态保持开放。
