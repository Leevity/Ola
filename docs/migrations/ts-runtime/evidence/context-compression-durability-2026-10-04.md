# 上下文压缩运行与持久化补验（2026-10-04）

范围：P10，对话页手动压缩与“压缩至此”预览，Windows x64、简体中文、标记过的隔离 Electron 数据根。

## 定位与修复

手动压缩原先直接调用 `agent:compress-context:msgpack`，源码中没有对应 Main 处理器。改为使用现有 TS Runtime 文本运行路径，并把运行绑定到真实业务会话；之前的临时 `context-compression:<uuid>` 会被 Main 以 `SESSION_WORKSPACE_MISMATCH` 拒绝。无法绑定模型、Runtime 不可用、不支持文本或摘要为空时明确失败，不再尝试无处理器的兼容 IPC。

摘要原先先更新 Renderer 消息，再经会吞掉异常的队列写入数据库，磁盘失败仍可能显示“已压缩”。现在压缩路径等待严格的会话写入成功，之后才替换内存消息；失败保留原消息。如写入过程中该会话消息发生变化，恢复最新消息并返回未压缩，避免覆盖新回合。重试时清除旧压缩错误提示。

## 验证

- `context-compression-ts-runtime.test.ts` 与 `context-compression-persistence.test.ts` 合计 7/7，通过 TS 文本运行、无 Runtime 时关闭、模型错误传播、数据库拒绝时原消息不变、写入确认后才显示摘要，以及写入中的新消息保护。
- `npm run build`、Node/Web 类型检查、定向 ESLint/Prettier 通过。
- `top-level-pages-electron.test.ts` 在源码与新 Windows x64 安装版各 1/1 通过：隔离本地 OpenAI 兼容 SSE 服务返回摘要，确认有实际模型请求；SQLite `BEFORE INSERT` 触发器拒绝摘要写入，页面提示失败且原库仍为 4 条消息；移除触发器后单击重试，至少 2 条摘要标记消息落库；Electron 重启后摘要仍可见。测试结束会删除带标记的临时数据库和本地服务。
- 源码截图：`analysis/audits/2026-10-03-settings-visual/top-level-pages/source/08-context-compression-persisted.png`；安装版截图：`analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/08-context-compression-persisted.png`。
- 新 Windows x64 NSIS SHA-256 为 `1008D9E2A1A0DB5A90B14C5F7F5DE877BED600BDE60E62FAD2FBF058EA74C87`。以 `/S /CURRENTUSER` 安装到 `C:\tmp\ola-release-current-20261004pp`，退出码 0。隔离安装版启动 `passed: true`；扫描 733 个解包文件与 5197 个 ASAR 条目，无旧 Worker/.NET 运行时资产。

## 边界

模型服务为本机确定性 SSE 替身，证明生产调用链和失败恢复，不代表真实服务商质量或网络环境。其他平台、长对话摘要质量、并发多窗口及中文输入法实机交互仍需验收。P10 与整体迁移退出保持开放。

## 已提交写入与通知失败的补验

Main 的消息替换 IPC 原先在数据库提交后继续查询会话并广播更新；若此时通知阶段查询失败，IPC 会报错，导致用户以为压缩未保存，但重启后摘要已经存在。现在已提交写入的通知异常仅记录警告，IPC 返回成功；真正的写入失败仍向调用方抛出。`db-ipc-message-scope.test.ts` 分别覆盖这两种情况，连同持久化专项共 24/24 通过。`npm run build` 和类型检查通过。

最新 Windows x64 NSIS SHA-256 为 `5CB6B7B226036C902E94090C0975A0D462997310BBB8237239F4EECDF365B7D8`，安装在独立目录 `C:\tmp\ola-release-current-20261004qq`，安装退出码 0。安装版 `top-level-pages-electron.test.ts` 1/1 通过，含模型请求、真实 SQLite 写入拒绝、恢复重试和重启读取。隔离启动 `passed: true`，733 个解包文件及 5197 个 ASAR 条目无旧 Worker/.NET 资产。通知阶段故障由 IPC 测试注入，尚未在真实多窗口环境下注入。

## “压缩到此处”预览和确认补验

预览结果现在绑定生成时的会话 ID 和所选消息以前的完整消息快照。确认时若会话已切换、消息被修改或 Agent 正在运行，拒绝应用旧摘要；预览请求跨会话返回时不再打开旧对话框。生成/应用失败提示改为中英文资源，应用异常有可见反馈。

`top-level-pages-electron.test.ts` 使用隔离本地模型服务，在源码版与 Windows x64 独立安装版各 1/1 通过：在消息菜单点“压缩到此处”，预览中显示摘要且数据库仍为 4 条原消息；取消后不落库；再次预览期间切换会话，对话框关闭且数据库仍未改变；返回原会话重新生成并确认，数据库新增至少 2 条压缩标记消息，原 4 条消息完整保留。源码和安装版截图分别为 `analysis/audits/2026-10-03-settings-visual/top-level-pages/source/09-context-compression-preview-applied.png` 与 `analysis/audits/2026-10-03-settings-visual/top-level-pages/installed/09-context-compression-preview-applied.png`。

新 Windows x64 NSIS SHA-256 `FDE3EA31EC7FCF5311D54CD3D1F7F1AAFE0F4CC31345066F8A6AF5F938EE5631`，独立目录 `C:\tmp\ola-release-current-20261004rr` 安装退出码 0。安装版完整 Electron 用例 1/1、隔离启动 `passed: true`，733 个解包文件和 5197 个 ASAR 条目无旧 Worker/.NET 资产。`npm run build`、类型检查、定向 ESLint、Prettier 和非严格 i18n 检查通过；其他 14 种语言仍有回退项。消息在预览期间被其他窗口编辑的可见验收、真实服务商摘要质量和其他平台仍开放。
