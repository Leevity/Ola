# 桌面流程保存失败恢复与原生确认语言（2026-10-04）

范围：P10/W9，Windows x64、简体中文、隔离 Electron 数据根。Main 的桌面流程 `sync` 端点现只报告 TS 仓库的工作区可用性，不进行第二份存储同步。设置页读取前检查该状态，避免工作区不可用时把空数组显示成“没有已保存流程”。

## 保存边界

旧流程是 Renderer 先请求 `desktop-recorder:stop` 清空 Main 内存录制，再单独请求 `desktop-flow:save`。第二步失败时刚录的流程无法在页面重试。现在 Main 的停止 IPC 先暂停接收新步骤，清理键入文本，再写入 TS BusinessRepository；只有写入和工作区复核成功后才清空录制并回传结果。失败时恢复原暂停状态、保留录制与当前流程，用户可重新点“停止并保存”。同一流程的并发保存由现有变更锁拒绝。

`desktop-flow-ipc-workspace.test.ts` 24/24 通过，新增断言覆盖写入拒绝后录制未停止、重试只结束一次、持久化前键入文本被清理，以及中文/英文原生重放确认框的标题和按钮；两种语言都保持“取消”为默认按钮。

## 可见故障与恢复

在标记过的临时 SQLite 库中，Electron 流程暂时重命名 `desktop_flows`，页面显示[读取错误和重试按钮](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/10-desktop-automation-load-failure.png)；恢复表并点击重试后显示正常状态。随后通过 `BEFORE INSERT` 触发器拒绝保存，页面显示[保存失败提示、仍在录制的状态和可用的停止按钮](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/10-desktop-automation-save-failure.png)；移除触发器并再次停止，页面显示[一条已保存流程](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/10-desktop-automation-save-recovered.png)，数据库查询也确认为一条。源码与最新安装版 `top-level-pages-electron.test.ts` 各 1/1 通过。故障只施加在临时测试库，测试结束后恢复表名并删除触发器。

完整源码构建、Node/Web 类型检查、定向 ESLint/Prettier 通过。Windows x64 NSIS SHA-256 `F782185015A05831620634F68ED1BA6C1B41B6F04396749702871290507167F5`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004nn` 安装，退出码 0。安装版隔离进程启动返回 `passed: true`；运行时 staging 完整性检查通过；旧 Worker/.NET 扫描覆盖 738 个解包文件及 5197 个 ASAR 条目，无遗留资产。

边界：原生确认框语言由 IPC 单元测试核对传给 Electron 的按钮与文案，未在真实桌面上拍摄原生弹窗或重放外部应用；其他保存/删除/取消失败路径、进程在写入途中崩溃、真实系统缩放和其他平台仍待验收。P10 和发布台账继续开放。
