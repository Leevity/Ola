# Windows x64 官方旧版安装器原位升级检查（2026-10-03）

## 来源与隔离边界

- 旧版来自项目官方 GitHub Release [`v1.0.4`](https://github.com/Leevity/Ola/releases/tag/v1.0.4) 的 `Ola-win-amd64-setup.exe`，大小 230,854,633 字节。下载后 SHA-256 为 `FC202A2825245FF5B3161C37ADAAAA043A17D0698CBA14B7ABBE9FD55839498D`，与该 Release API 公布的 digest 一致。
- 新版为当前源码打包的 Windows x64 NSIS，SHA-256 为 `077FF553938F8301E42D6EAB75D0FDAD5B5CF0E0FFC19E617AFEC56FAC3935FC`。
- 两个安装器都使用 `/S /CURRENTUSER /D=C:\tmp\ola-upgrade-104-to-105`，旧版程序未启动。旧版源码用 `os.homedir()` 和 .NET `Environment.SpecialFolder.UserProfile` 访问 `~/.ola`；在没有独立 Windows 用户配置文件的情况下运行它会有触及真实用户数据的风险。本检查不声称完成旧版真实用户数据生成或端到端迁移。

## 实测结果

1. 官方 v1.0.4 安装器退出码 0；同一路径 `Ola.exe` 的 ProductVersion 和 FileVersion 均为 `1.0.4.0`。旧包内含 `resources/app.asar.unpacked/resources/native-worker/Ola.Native.Worker.exe`。
2. 在完全相同路径运行当前 v1.0.5 安装器，退出码 0；`Ola.exe` 的 ProductVersion 和 FileVersion 均变为 `1.0.5.0`。旧 `resources/app.asar.unpacked/resources/native-worker` 目录不存在。
3. 对升级后的路径执行 `verify-runtime-staging.mjs --platform=win32` 通过；`verify-legacy-artifacts.mjs` 检查 733 个解包文件和 5,197 个 ASAR 条目，未发现旧 Worker/.NET 运行时资产。
4. `verify-packaged-electron-process-startup.mjs` 用独立 `OLA_E2E_DATA_ROOT` 启动升级后程序，返回 `passed: true`，确认安装目录 Renderer 加载、TypeScript Runtime 就绪、窗口可见；数据根是 `C:\Users\80663\AppData\Local\Temp\ola-packaged-process-startup-hbQcpr`。

## 剩余验收

此记录证明 Windows x64 安装器从官方 1.0.4 到当前 1.0.5 的同路径覆盖、旧资产清除和新版启动。仍需在真正隔离的 Windows 用户配置文件中运行旧版生成业务数据，再验证新版本原位升级后的项目、会话、设置及凭据连续性。现有 P8 旧库交接测试覆盖合成旧库的迁移与恢复，但不能替代此原生端到端场景。因此 Windows x64 发布目标继续开放。

## 2026-10-04 当前候选包重验

- 官方 1.0.4 安装器本地 SHA-256 再核对为 `FC202A2825245FF5B3161C37ADAAAA043A17D0698CBA14B7ABBE9FD55839498D`。以 `/S /CURRENTUSER /D=C:\tmp\ola-upgrade-104-to-105-20261004` 安装到新目录，退出码 0，`Ola.exe` 为 `1.0.4.0`，旧 Native Worker 存在。未启动旧版。
- 在同一目录安装当前候选 NSIS（SHA-256 `D4980DAA664199451CF3061D8E897EE6F7F69C49E29D79C7C31FB8EFB7C21BDC`），退出码 0，`Ola.exe` 的 ProductVersion/FileVersion 均变为 `1.0.5.0`，旧 Worker 文件消失。
- 升级后 `verify-runtime-staging.mjs --platform=win32` 通过；`verify-legacy-artifacts.mjs` 检查 733 个解包文件和 5197 个 ASAR 条目无旧运行资产；`verify-packaged-electron-process-startup.mjs` 用带标记的隔离数据根返回 `passed: true`，安装目录 Renderer 加载、TS Runtime 就绪、主窗口可见。
- 此重验确认当前候选包的二进制覆盖升级和启动。旧版没有在隔离 Windows 用户下生成真实业务数据，因此项目、会话、设置和凭据的旧版实数据连续性仍未签收，Windows x64 发布目标保持开放。

## 2026-10-04 旧版用户目录隔离核查

- 官方 1.0.4 安装器仍在 `C:\tmp\Ola-win-amd64-1.0.4-setup.exe`，本轮没有启动旧版程序。当前进程的子进程测试中将 `USERPROFILE` 设为 `C:\tmp\ola-isolated-profile-probe` 后，Windows PowerShell 的 `[Environment]::GetFolderPath('UserProfile')` 仍返回真实的 `C:\Users\80663`。旧版使用 .NET `Environment.SpecialFolder.UserProfile`，因此单纯环境变量覆盖不足以隔离其数据根。
- 本轮继续保持“旧版真实业务数据连续性”开放；需要独立 Windows 用户配置文件或同等隔离环境，才能安全运行旧版生成项目、会话、设置和凭据并做原位升级验收。仅二进制覆盖和新版隔离启动的现有证据不能替代该流程。
