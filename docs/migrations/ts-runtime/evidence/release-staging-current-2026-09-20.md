# 六平台当前 staging 复核 — 2026-09-20

本机对当前六份解包 staging 逐一执行了 `verify-runtime-staging.mjs` 和 `verify-legacy-artifacts.mjs`：

| 目标 | Runtime staging | 遗留资产扫描 |
| --- | --- | --- |
| Windows x64 | 通过 | 642 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |
| Windows arm64 | 通过 | 642 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |
| Linux x64 | 通过 | 629 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |
| Linux arm64 | 通过 | 629 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |
| macOS x64 | 通过 | 822 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |
| macOS arm64 | 通过 | 822 个文件，无 Native Worker、CodeGraph Worker 或 .NET runtime 资产 |

该证据只证明当前解包构建的资源完整性和无旧运行时资产；Windows/Linux 原生机器安装、升级、启动和签名，以及 macOS Developer ID 签名/公证仍未完成，不能据此把发布目标标记为“通过”。
