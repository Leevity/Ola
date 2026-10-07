# Windows 安装版 CodeGraph 语法资源补包

日期：2026-10-03。所有可见 Electron 流程均使用带 `.ola-e2e-root` 标记的临时数据根，没有访问日常 `~/.ola`。

## 缺陷证据

Windows x64 旧安装包 `4741902DC81489636202F1E49923DB4A0D2082445EBB52A2A5D730FD9B2E24A3` 打开设置页“项目智能”时，出现全局未处理错误：`Cannot find module 'tree-sitter-wasms/out/tree-sitter-typescript.wasm'`。项目内初次截图的第 18–22 页被错误提示遮挡，不能作为视觉通过证据。新增 Electron 巡检断言后，同一旧安装包在“项目智能”页确定性失败；源码版通过，说明问题在发布产物。

根因是精简发布依赖清单未包含按绝对文件路径动态加载的语法 WASM。直接把 `tree-sitter-wasms` 纳入依赖使 electron-builder 分别在 8GB 与 16GB Node 堆上限处耗尽内存，不能作为可落地的发布修复。

## 修复

- 打包脚本从已安装的 `tree-sitter-wasms/out` 提取解析器声明支持的 20 个包内语法文件，复制到发布资源目录；另 3 个自带语法文件原样保留。`wasm-parser` 优先使用发布资源路径，源码开发仍可回退到包内路径，资源不可用时返回明确的 `unavailable`。
- 运行时和正式发布两条 staging 路径共用复制逻辑。产物完整性门禁逐项检查 20 个语法文件以及 `web-tree-sitter` 核心 WASM；缺失任一测试资源时门禁失败。恢复原 8GB 构建上限后，Windows x64 NSIS/ZIP 打包成功。
- 设置页 Electron 测试新增每页未处理错误提示断言，以及“项目智能”页 CodeGraph 语法状态 18/18 可用、安装版实际索引 TypeScript 文件的检查。

## 验证

- `tests/runtime/runtime-staging-integrity.test.ts`：7/7 通过，含缺失核心 WASM、缺失 TypeScript 语法的反例。
- `npm run typecheck:runtime`、`npm run build`、`npm run verify:ts-codegraph`、定向 ESLint/Prettier：通过。
- 新 Windows x64 安装包 SHA-256：`FF8E2C89B62C4B6119A32DC8EDAEC20F1E789F7AAB3A190478D99C4287134D36`。`/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261003o`，退出 0。
- 安装目录 `verify-runtime-staging` 通过；`app.asar.unpacked/resources/codegraph/grammars` 有 23 个语法 WASM（20 个复制文件、3 个原有文件）。安装版设置页完整 Electron 流程通过，包括 22 页无未处理错误、CodeGraph 状态 18/18、TypeScript 文件实际索引成功、设置写盘故障恢复和重启。安装版任务看板完整流程 1/1 通过。
- 隔离安装版启动 `passed: true`，加载安装目录 Renderer，TS Runtime 就绪且窗口可见；临时业务库 schema v12，包含 `sessions.scenario_policy`。733 个解包文件和 5197 个 ASAR 条目无旧 Worker/.NET 资产。签名 `NotSigned` 使用已登记豁免。
- 新截图保存在 [项目内视觉审查](../../../../analysis/audits/2026-10-03-settings-visual/审查记录.md)；初次被遮挡的截图保留为缺陷证据，修复后截图在 `after-fix/` 中。

真实旧版原位升级、其他平台原生安装与完整设置交互/视觉签收仍开放，P10/P12 不因此改为通过。
