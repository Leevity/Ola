# Windows 设置文件原子替换重试

日期：2026-10-03。所有 Electron 用例使用带 `.ola-e2e-root` 标记的临时数据根，未访问日常 `~/.ola`。

## 复现与定位

安装版 `FB49C81D952B1BF588EFA057C63EA62A94D178F01A8F0CF0AB117E6B2F1F3794` 的完整看板流程在 7 次运行中 3 次通过、4 次在项目终端停靠偏好持久化断言处失败。失败时界面已切换布局，但 Main 缓存和 `settings.json` 仍是旧值。Main 日志记录 `settings:set:msgpack` 中的 `EPERM: operation not permitted, rename '...settings.<uuid>.tmp' -> '...settings.json'`。这证明本次间歇失败发生在原子替换目标文件的系统调用上，而非看板状态映射或测试读取顺序。

## 修复

`SettingsStore` 对 `EPERM`、`EACCES`、`EBUSY` 的目标文件替换做最多 8 次有限退避重试（20ms 起、单次最多 200ms）。若目标是目录则立即失败；持续失败仍返回原错误，保持旧设置文件，并清理本次创建的临时文件。设置修改继续通过原有写入队列串行执行。

## 当前验证

- 新增确定性单元用例：前两次 `EPERM` 后第三次替换成功；连续 8 次 `EPERM` 后原文件不变、临时文件被清理，解除锁定后同一写入队列可再次成功。设置相关 3 个测试文件 10 项通过。
- `npm run typecheck:node`、定向 ESLint、`npm run build` 通过。
- 源码版完整看板 Electron 流程 1/1 通过；设置页真实故障/重试/重启 Electron 流程 1/1 通过。

## 安装版复验

修复版完整构建和 Windows x64 staging 打包退出 0；NSIS SHA-256 为 `4741902DC81489636202F1E49923DB4A0D2082445EBB52A2A5D730FD9B2E24A3`。以 `/S /CURRENTUSER` 安装到独立目录 `C:\tmp\ola-release-current-20261003n`，安装退出 0。同一安装包的完整看板 Electron 流程连续运行 5 次，5/5 通过，包含两个项目的终端停靠位置写盘及重启恢复；设置页真实故障/重试/重启流程 1/1 通过。

安装版隔离启动 `passed: true`，Renderer 从安装目录加载、TS Runtime 就绪、窗口可见；临时业务库 schema v12 且含 `sessions.scenario_policy`。713 个解包文件和 5177 个 ASAR 条目无旧 Worker/.NET 运行时；签名状态 `NotSigned`，沿用既有豁免。

这证明已复现的 `EPERM` 间歇故障在本机新包的 5 次重复运行中未再出现。真实用户长期运行和其他平台仍待验收，不能用本机重复测试替代 P10/P12 的全部退出条件。
