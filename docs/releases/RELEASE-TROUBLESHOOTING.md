# Ola 发布构建故障记录与预防

这份记录用于避免重复踩到 1.0.6 构建期间发现的问题。发布工作流仍以质量门禁、平台打包、安装器烟测和产物校验全部成功为准。

## 1. macOS Intel DMG 临时盘无法卸载

现象：electron-builder 的 DMG 任务报 `Unable to detach device cleanly` 或 `Resource busy`。这属于 DMG 辅助工具卸载临时设备的竞态，不代表应用归档损坏。

处理：未签名 macOS 构建先生成 ZIP，再由 `scripts/native-unsigned-dmg.mjs` 使用系统 `hdiutil create` 创建 DMG，并立即执行 `hdiutil verify`。签名构建仍使用 electron-builder 的签名 DMG 路径。

预防：不要在未签名构建中直接依赖 electron-builder 的 DMG 辅助工具；`tests/runtime/release-packaging-options.test.ts` 固定检查目标组合和输出路径约束。

## 2. Windows ARM64 安装目录缺少主程序

现象：NSIS 进程退出码为 0，但安装目录只有卸载程序、资源文件和压缩包，缺少 `ola.exe`。原因是 ARM64 包使用的 7-Zip BCJ2 过滤器无法被当前 NSIS 解码器正确展开。

处理：`scripts/release-packaging-options.mjs` 只为 Windows ARM64 设置 `ELECTRON_BUILDER_7Z_FILTER=BCJ`，保留 x64 的原有环境，不改变发布签名策略。

预防：工作流必须执行 Windows 安装器烟测，检查安装目录中存在主程序；不要只根据打包命令的退出码判断成功。

## 3. Windows SPDX 清单无法读取依赖

现象：Windows 两架构在产物验证阶段报 `No installed dependency manifests` 或从 `app.asar` 提取 `package.json` 失败。electron-builder 会把部分依赖放入 `app.asar.unpacked`，而 `asar.listPackage()` 仍可能列出这些路径。

处理：`scripts/release-sbom.mjs` 同时读取 `app.asar` 中可提取的清单和旁边 `app.asar.unpacked/node_modules` 中的清单，并统一路径分隔符；清单仍只来自最终包内容，不读取开发锁文件。

预防：保留归档清单回归测试，覆盖嵌套依赖、外置依赖、缺失清单和非法 SHA256；发布校验必须在每个 Windows 架构上执行。

## 4. 发布操作顺序

1. 先以 `publish=false` 运行完整矩阵，确认质量、编译、平台打包、安装器烟测和 SPDX/SHA256 校验全部成功。
2. 检查失败 job 的具体步骤，不用跳过平台或降低校验条件来“通过”。
3. 再以相同提交运行 `publish=true`，由工作流上传并发布 draft Release。
4. 发布后核对 Release 状态、目标提交、六个平台资产、校验文件和 SPDX 清单。

当前版本未配置 Apple Developer 或 Windows Authenticode 证书，因此 1.0.6 是未签名发布；这不会改变上述构建完整性检查。
