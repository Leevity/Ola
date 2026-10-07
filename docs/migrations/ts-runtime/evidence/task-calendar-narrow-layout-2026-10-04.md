# 任务日历窄窗布局修复（2026-10-04）

范围：W9/P10，Windows x64、简体中文、760×560 窗口在 150% 下的等效 507×373 CSS 视口。使用带标记的隔离 Electron 数据根，不读取真实用户数据。

## 复现与修复

上一版安装包 `C:\tmp\ola-release-current-20261004jj\Ola.exe` 的窄窗巡检按预期失败：右侧详情仅约 **76px** 宽、文字被挤成逐字竖列；左侧面板仅约 301px 高，而日历自身 360px，高出面板底部。[修复前截图](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/before-task-narrow/01-tasks-narrow.png)和[几何数据](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/before-task-narrow/01-tasks-narrow-layout.json)保留原貌。此时文档宽度仍等于视口，因此旧的“无横向溢出”检查没有发现可读性问题。

任务页在窄窗改为纵向排列，给日历/当日列表和详情保留足够高度，并让主区域滚动；宽窗仍使用双栏。最新源码巡检 1/1 通过：左侧和详情各约 **463px** 宽，详情在左侧下方，日历不超出左侧面板，滚动到底部后详情进入视口。[修复后首屏](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/source/01-tasks-narrow.png)、[下滑后详情](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/source/01-tasks-narrow-detail.png)与[几何数据](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/source/01-tasks-narrow-layout.json)已人工复核。完整源码构建、Runtime 类型检查和定向 ESLint 通过。

## 独立安装版复验

Windows x64 NSIS 安装包 SHA-256 `171A93C26D0901B6341129B72F0027D9CE570DC51185EBAFE13E0C4C758223A5`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004ll` 安装，退出码 0。同包 `top-level-pages-electron.test.ts` 1/1 通过；507×373 CSS 视口下文档宽度为 507px，两面板各约 **464px** 宽，详情从 y=752 开始，位于左侧面板底部 y=736 之后；日历底部 y=416 未越过面板底部。主区域滚动高度 1048px，视口高度 333px，滚动后详情完整进入视口。[安装版首屏](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/01-tasks-narrow.png)、[下滑后详情](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/01-tasks-narrow-detail.png)和[几何数据](../../../../analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/01-tasks-narrow-layout.json)已保存。

安装版隔离进程启动返回 `passed: true`；运行时 staging 完整性检查通过；旧 Worker/.NET 资产扫描覆盖 738 个解包文件及 5197 个 ASAR 条目，无遗留资产。此专项只补齐任务日历窄窗可读性证据，不改变 P1/P10/P12 和跨平台发布项的正式状态。

边界：等效视口测试不代替真实系统显示缩放；空数据详情已验证，含大量任务与运行记录的长列表、真实键盘/读屏及各平台仍待验收。
