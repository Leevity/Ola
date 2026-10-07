# 系统设置表单可访问性补验（2026-10-04）

范围：简体中文、Windows x64 源码构建、隔离 `OLA_E2E_DATA_ROOT`。这是 P10/W9 的局部证据，不关闭设置页的整体视觉与读屏验收。

- 系统设置中的 Shell 执行端、Shell 环境变量、系统代理和条件显示的自定义 Shell 路径均通过 `label` 关联实际控件。执行端和代理的说明文字通过 `aria-describedby` 关联；环境变量格式错误时同时设置 `aria-invalid` 并关联可见错误文本。
- 平台状态徽标显示用户可识别的 Windows、macOS 或 Linux 名称，未知平台仍显示原始平台值。
- `npm run typecheck`、定向 ESLint、完整 `npm run build` 通过。`RUN_SETTINGS_SAVE_ELECTRON_E2E=1` 的隔离 Electron 流程 1/1 通过，其中核对控件关联、Windows 状态名称、环境变量错误状态；同一流程继续通过 22 个设置子页、CodeGraph 索引和设置写盘故障恢复。
- [系统设置截图](../../../../analysis/audits/2026-10-03-settings-visual/after-system-labels/09-settings-page.png)为 150% 等效窄视口首屏，人工复核状态徽标和主要文字未被裁切。
- 本轮 Windows x64 NSIS 安装包 SHA-256 为 `A6712FC01071F44F2E2ED21BB7BFF1CA3E7126DDA86321BD634835DA6C29DD2B`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004hh` 安装，退出码 0。安装版相同 Electron 设置流程 1/1 通过；[安装版系统设置截图](../../../../analysis/audits/2026-10-03-settings-visual/installed-system-labels-hh/09-settings-page.png)已人工复核。隔离启动返回 `passed: true`，运行时资源完整性通过；扫描 738 个解包文件和 5197 个 ASAR 条目，无旧 Worker 运行资产。

边界：DevTools 合成的 Ctrl+加号事件没有触发 Electron 主进程缩放快捷键，不能据此宣称真实应用缩放通过或失败。该失败的探索断言已撤回；真实系统显示缩放、完整键盘顺序、读屏朗读与所有设置弹窗仍待验收。
