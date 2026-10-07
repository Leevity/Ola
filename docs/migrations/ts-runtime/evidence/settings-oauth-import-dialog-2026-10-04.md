# OAuth 账户导入弹窗窄窗补验

日期：2026-10-04。范围：P10，AI 服务商 → Codex (OAuth) → OAuth 账户 → 粘贴 JSON，简体中文、源码和 Windows x64 安装版隔离 Electron。窗口覆盖 760×560 的 150% 等效视口，以及 507×300 CSS 的更短视口；未输入或导入真实令牌。

初次流程发现 JSON 输入框没有可访问名称。补名后进一步发现 300px 高度下固定 160px 输入区把“导入”按钮挤到弹窗底部之外约 25px。现在输入框使用本地化的“导入账户 JSON”名称，弹窗限制最大高度并允许滚动，输入区随视口高度缩小；完整标题、说明、输入框、取消与导入按钮在该短视口同屏可见。

源码和 Windows x64 安装版 `settings-save-failure-electron.test.ts` 各 1/1 通过。流程从真实设置页选中 Codex OAuth 服务商并打开导入弹窗，检查输入框名称、弹窗标题/说明引用、视口边界、按钮边界和短窗口无裁切，再取消弹窗；其余 22 个设置子页、键盘操作和写盘失败恢复继续通过。[源码普通窄窗](../../../../analysis/audits/2026-10-03-settings-visual/after-oauth-import-dialog-source/24-oauth-import-dialog.png)、[源码更短视口](../../../../analysis/audits/2026-10-03-settings-visual/after-oauth-import-dialog-source/25-oauth-import-short.png)及[安装版更短视口](../../../../analysis/audits/2026-10-03-settings-visual/after-oauth-import-dialog-installed/25-oauth-import-short.png)截图已复核。`npm run build`、定向 ESLint 和设置视觉契约通过。

精简发布暂存生成的 NSIS 安装包 SHA-256 为 `1AB1A21AF594B4032F9DB4F52698E34F53BB77491D3D28D250CA153CE3839440`，以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004ww`，退出码 0；隔离启动 `passed: true`。733 个解包文件及 5197 个 ASAR 条目未发现旧 Worker/.NET 资产。

本轮未提交 JSON，不能证明真实 OAuth 令牌导入、加密存储、错误反馈和账户切换。等效视口不替代真实系统缩放和读屏朗读。P10 保持“实现中”。
