# OAuth 账户导入与导出失败路径补验

日期：2026-10-04。范围：P10，简体中文设置页 → AI 服务商 → Codex (OAuth)。仅使用隔离 E2E 数据目录、`example.invalid` 邮箱和假令牌；未使用用户的真实账户或令牌。

`AccountListEditor.tsx` 的导入成功提示改为插入 `result.imported.length`，使“成功导入 1 条，跳过 0 条”显示实际数量。导出账户 JSON 时，剪贴板不可用或写入被拒绝会显示本地化错误；不再把含令牌的 JSON 作为提示框正文，也不会在写入失败时误报复制成功。

`settings-save-failure-electron.test.ts` 从真实设置页打开导入弹窗，提交一个未来过期的假 OAuth 记录，检查账户列表和数字成功提示，再模拟剪贴板拒绝，检查错误提示且页面正文不含假令牌。重启应用后再次进入 Codex (OAuth) 并确认账户仍显示。源码构建版与本轮安装版各 1/1 通过；`npm run build` 与定向 ESLint 通过。

本轮 Windows x64 精简发布暂存生成 NSIS 安装包 SHA-256：`794E7F6D8C01CB692BFE6CACD0213A39E8F50FEFC50352799853F706B8506035`。安装到 `C:\tmp\ola-release-current-20261004xy` 后，隔离启动 `passed: true`；检查 733 个解包文件和 5197 个 ASAR 条目，未发现旧 Worker/.NET 资产。上述结果证明此安装版的对应界面流程，不代表真实 OAuth 服务端鉴权成功。

**安全边界后续：** 本记录初次检查发现 `config.json` 中的明文认证字段；随后已接入 Main 加密投影。全新 profile 首次保存后立即异常退出的密钥恢复问题已在本机 Windows x64 源码和解包版复现并修复；远程账户、Mesh、待完成 OAuth、旧凭据保险库及 Cookie 归档的隔离异常退出证据见[加密迁移阶段证据](provider-credential-storage-2026-10-04.md)。原生安装、跨平台和真实主站仍待验收，P3/P10/P12 均保持“实现中”。
