# Windows x64 旧版升级基线尝试（2026-10-03）

## 来源与结果

- 使用已附着的隔离工作树，精确检出仓库标签 `v1.0.4`（提交 `ff2c9265ff477452f4042612fda355569a27ebfd`）。这是从源码本机重建的包，并非已取得或校验的正式线上发布资产。
- `npm run build` 因本地 `@types/plist` 安装目录缺少类型文件而失败。单独的 `npx electron-vite build` 成功；`npx electron-builder --win nsis --x64 --publish never` 生成 `ola-1.0.4-setup.exe`，SHA-256 为 `C41BDB4A6C110ED79F7931AC551BDCB2C9F4C6EFD5095EA10EA14960E613FDDC`。
- 旧安装包能静默安装，但首次启动报告缺少 Native Worker，设置和用户内容初始化失败。该安装包不具备完整旧版功能，不可用于签收原位升级。
- 另从同一标签源码离线构建了非 AOT、self-contained 的 Worker 作诊断。它能连接 IPC 并初始化旧库，但缺少 CodeGraph Worker 资产；仍不是正式发布组合。

## 数据隔离发现

- 旧版 .NET Worker 使用 `Environment.SpecialFolder.UserProfile` 解析数据路径；仅为进程设置 `USERPROFILE`、`HOME` 和临时 Electron userData 没有隔离该路径。诊断启动日志显示旧 Worker 使用真实的 `~/.ola/data.db`。
- 测试期间真实 `~/.ola/settings.json`、`config.json`、`extensions.json` 和 `data.db-wal` 的修改时间发生变化。没有试验前的逐文件基线，不能判断内容差异或安全地自动回滚。
- 已停止旧版进程。当前文件及 SQLite 主库/WAL/SHM 的六份副本与 SHA-256 清单保存在用户目录下的 `.ola-recovery-20261003`，不纳入仓库。不要把该目录提交或发给第三方。
- NSIS 使用相同 appId，旧版安装替换了先前安装的当前版。已再次安装本轮构建的 `1.0.5`；安装目录中的 `app.asar/package.json` 为 `1.0.5`，其隔离启动检查通过。
- 新的 `verify-packaged-electron-process-startup.mjs` 在启动前比对已安装包与仓库版本，并检查 Main bundle 支持 `OLA_E2E_DATA_ROOT`；对 `v1.0.4` 包会先拒绝，不再启动旧版。

## 验收结论

Windows x64 的正式旧版原位升级仍未验收。后续只能在真正独立的 Windows 用户账户或虚拟机中，以已校验的正式旧版安装资产和预先备份的数据执行；不能再依赖环境变量隔离旧 Worker。当前 `~/.ola` 不做自动恢复，待拿到事故前备份或用户确认后逐项比对。
