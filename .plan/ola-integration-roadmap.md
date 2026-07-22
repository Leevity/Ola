# Ola 完整能力与聊天体验改造路线

> 状态：阶段 0–21 已完成本地实现、分阶段提交与自动门禁；阶段 11–21 已按独立分支实施。最终远端上传门禁执行中。
> 原则：每阶段从最新 `main` 创建 `codex/` 分支，代码、中英文案、专项验证和桌面烟测完成后再提交；提交说明只描述 Ola。

## 交付门禁

每个阶段至少通过：

- `npm run typecheck`
- `npm run lint`（0 error，既有 warning 单独记录）
- `npm run build`
- 对应 `verify:*` 专项验证
- `npm run dev` 桌面烟测

涉及 Worker 时增加 Native 构建和真实协议验证；涉及凭据、Cookie、Provider 时增加明文泄漏扫描；涉及长列表、日志和媒体时验证内存、磁盘与记录上限。本路线完成前只上传 Commits，不创建 Release。

## 已完成基线（阶段 0–10）

- Native 权限策略、Provider 重试与压缩、输入草稿、内容块和执行摘要。
- Hooks 生命周期、可信加载、管理 UI 和有界历史清理。
- 子 Agent SQLite 历史、分页恢复、迁移、并发写入与精确取消。
- CodeGraph 独立 Worker、语法资产、按需索引和 Agent 工具。
- Worker 资产 manifest、绿色构建配置、更新校验与 Worker recycle。
- SSH 功能审计：主机、终端、SFTP、密钥和运维工作区主体已存在。

## 本轮完成记录（阶段 11–21）

| 阶段 | 状态 | 验证重点 |
| --- | --- | --- |
| 11 | 已完成 | 长会话锚点、消息轨道、折叠与工具结果 |
| 12 | 已完成 | 多浏览器 Cookie 解密、隔离导入与临时清理 |
| 13–14 | 已完成 | AI Coding 配置校验与安全终端注入 |
| 15–17 | 已完成 | SSH 契约模块化、重连诊断与续传重试 |
| 18 | 已完成 | CodeGraph Dashboard、真实 Worker 协议与 macOS IPC 路径 |
| 19 | 已完成 | Provider 共享契约、Main 脱敏只读镜像与一致性哈希 |
| 20 | 已完成 | 节点画布、图片操作、项目资产库与 Canvas Agent 工具 |
| 21 | 已完成 | 安全媒体协议、缓存上限、任务生命周期与 Video Node；真实计费供应商未启用 |

“已完成”表示代码、中文/英文、专项验证、生产构建与桌面启动烟测通过；不表示已创建 Release。

## 阶段 11：主聊天体验与长会话性能

分支：`codex/chat-experience`

### 实现

- 保留现有虚拟消息列表、用户消息定位、分页历史、执行过程摘要和最终答案优先展示。
- 为动态高度虚拟行增加尺寸补偿：视口上方行变化时保持锚点，贴底跟随时由贴底逻辑接管。
- 统一流式贴底状态；用户主动上滚即停止追随，程序滚动不触发退出，点击“回到底部”恢复。
- 在现有定位能力上增加统一消息轨道，标记用户、助手、流式和压缩摘要；支持鼠标、键盘和未加载历史跳转。
- 抽取支持 reduced-motion 的折叠高度容器，复用于思考块、工具卡和执行分组。
- 增加 Web Search 结果块、CodeGraph 工具卡、Bash 文件产物卡和简洁的推理强度滑杆。
- 输入区只增量吸收高度约束、焦点恢复和横向溢出修复，保留草稿、引用、技能、命令、模型与中文输入法行为。

### 验收

- 5000 条消息滚动无明显卡顿，加载旧消息不改变视口锚点。
- 流式输出、主动上滚、回到底部和会话切换状态正确。
- 展开大型思考或工具结果不跳屏；轨道可定位未加载历史。
- IME、AskUserQuestion、子 Agent、执行摘要和最终答案无回归。

## 阶段 12：浏览器 Cookie 导入

分支：`codex/browser-cookie-import`

- 检测 Chrome、Edge、Brave、Chromium 及其 Profile。
- macOS 走 Keychain、Windows 走当前用户 DPAPI、Linux 走对应 Chromium 解密流程。
- 只读取数据库临时副本，导入到 Ola 隔离 Session，结束后清理临时文件且不记录明文。
- 设置页提供来源、Profile、隐私确认、导入/跳过/失败统计和结构化错误。
- 验证三平台解密、重复导入、浏览器占用、授权失败、临时文件清理及日志脱敏。

## 阶段 13：AI Coding 配置

分支：`codex/ai-coding-config`

- 管理多套 Claude Code 与 Codex CLI 配置，只引用现有 Provider/模型，不复制密钥。
- 校验 Provider 状态、认证方式、协议、Base URL 和模型兼容性。
- 支持新增、复制、删除、启用、权限模式及最终环境映射预览；密钥只遮罩显示。

## 阶段 14：AI Coding Terminal

分支：`codex/ai-coding-terminal`

- 在本地项目终端提供 Claude Code/Codex 启动入口。
- Main 进程用子进程环境注入密钥，禁止拼入命令和终端历史。
- 启动前检查 CLI 与版本；SSH 远程终端默认禁用本地启动配置。
- 覆盖缺失 CLI、无效配置、权限拒绝、退出与进程清理。

## 阶段 15：SSH Store 与契约模块化

分支：`codex/ssh-store-modules`

- 提取 shared SSH contract。
- 将单体 store 拆为 connections、sessions、explorer、sftp、transfers、ui、events。
- 保留兼容导出，本阶段只迁移结构，不改变连接和传输语义。
- 使用现有 remote/SSH 专项验证覆盖连接、分页、双栏、取消和事件退订。

## 阶段 16：SSH 重连与诊断日志

分支：`codex/ssh-reconnect-logs`

- 增加 `reconnecting` 及 dial、handshake、auth、shell、reconnect 阶段事件。
- 网络故障按有上限的退避策略重连；用户主动断开绝不重连。
- 日志使用有界环形缓冲并脱敏密码、passphrase、私钥与 Token。

## 阶段 17：SFTP 续传与失败重试

分支：`codex/ssh-transfer-resume`

- 任务保留脱敏原始请求与冲突策略，支持失败重试和断点续传。
- 续传前校验源、目标、磁盘空间和远端状态。
- 覆盖取消/完成竞态、跨主机单端断开、文件变化及重复追加。

## 阶段 18：CodeGraph Dashboard

分支：`codex/codegraph-dashboard`

- 首版提供 Worker/资产状态、索引进度、语言统计、节点/边数量、符号搜索和源码跳转。
- 第二版增加调用方、被调用方和引用关系；最后增加局部关系图，禁止直接绘制全项目大图。
- 复用现有独立 Worker、插件开关和工具契约，不建立第二套后端。

## 阶段 19：Provider Main Store

分支：`codex/provider-main-store`

- 建立 Main、Renderer、Worker 共享契约，先提供 Main 只读镜像。
- 增加双写与一致性验证，密钥迁入安全存储后再切换唯一数据源。
- 保持 Provider ID、模型配置和用户数据兼容。

## 阶段 20：Draw Graph

### 20A 核心画布

分支：`codex/draw-graph-core`

- 升级现有 Draw 页面，不创建第二入口。
- 实现图片/文本/配置节点、连接、选择、缩放、小地图、撤销重做。
- 使用版本化项目 schema、原子保存和损坏恢复。

### 20B–20D 独立切片

- `codex/draw-image-ops`：裁剪、遮罩、扩图、放大。
- `codex/draw-projects`：项目切换、资产库、Prompt Library。
- `codex/draw-canvas-assistant`：画布 Agent 与节点操作工具。

## 阶段 21：视频与本地媒体

分支：`codex/media-runtime`

- 先建立安全本地媒体协议、缓存目录、大小上限和清理策略。
- 再实现视频任务、轮询、取消、失败恢复和 Video Node。
- 视频 Provider 作为默认关闭的可选插件；UI 显示预计费用、状态、大小与删除动作。
- Draw Graph、媒体协议和磁盘清理未验收前，不接入实际视频生成。

## 分阶段提交与验收规则

1. 每阶段只包含一个可回滚的垂直切片。
2. 契约、实现、持久化、UI/调用方必须闭环，不用 mock 冒充完成。
3. 中文与英文完整，其他语言使用英文 fallback。
4. 默认关闭高风险或计费能力，迁移必须幂等。
5. 自动门禁通过后再做桌面人工验收；人工验收未确认时标记“代码完成”，不能标记“发布完成”。
6. 提交标题与正文只描述 Ola，不包含外部仓库名称、路径或参考哈希。
