# 通用设置控件名称与滑块补验（2026-10-04）

范围：P10/W9 的简体中文设置页局部验收。生产代码中的通用设置开关、输入、选择和滑块原有可见标题未完整关联控件；共用 `Slider` 把 ARIA 名称留在不可聚焦的容器，滑块本身无名称。

实现：通用设置的自动更新、默认项目目录、背景颜色、字体、动画、工具栏折叠、工具密度和语言控件关联可见标题及说明。共用滑块把 ARIA 名称与说明传给实际可聚焦的 `Thumb`；字号、模型温度与图片画笔大小分别提供名称。仅为一组控件的栏目标题改用标题元素，避免无目标的 `label`。

证据：`npm run typecheck`、定向 ESLint、完整 `npm run build`、`npm run verify:settings-visual` 通过。隔离源码 Electron 设置流程 1/1 通过，核对通用设置 10 个控件的标签、9 个说明关联、字号滑块名称、模型温度滑块名称；其余既有 22 子页、CodeGraph 实际索引和保存故障恢复流程继续通过。[100% 通用设置首屏](../../../../analysis/audits/2026-10-03-settings-visual/after-general-labels/00-general-100-percent.png)已人工复核，没有发现此次语义调整造成的布局变化。

Windows x64 NSIS 安装包 SHA-256 为 `1A15FCD7F247B23F2C0BE281F700DBB913B4FF574039631E831F00BFF5760238`，以 `/S /CURRENTUSER /D=C:\tmp\ola-release-current-20261004ii` 安装，退出码 0。同包设置页 Electron 流程 1/1 通过，[安装版 100% 首屏](../../../../analysis/audits/2026-10-03-settings-visual/installed-general-labels-ii/00-general-100-percent.png)已人工复核。隔离启动返回 `passed: true`；运行时 staging 完整性通过；扫描 738 个解包文件和 5197 个 ASAR 条目，无旧 Worker 运行资产。

边界：DOM 中的名称与说明关联可用，不等同于屏幕阅读器端到端朗读验收。真实显示缩放、所有设置弹窗和其余语言仍需独立验收；P10 保持开放。
