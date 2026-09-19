# 1.0.5 安全修正与复核记录

本轮已关闭高风险默认路径：团队模型只接受平台 provider ID，缺失团队凭据返回 503；模型网关只接受 HTTPS 公网 origin，拒绝用户信息、回环、私网与链路本地地址，并在已验证 DNS 地址上建立连接以避免重绑定；JavaScript 扩展执行代码与 `node:vm` 已移除，已有包仅保留迁移元数据；Mesh Shell 被禁用，节点与票据只允许 `mesh.event.receive`、`system.info` 两项低风险能力，事件仅可传递状态；HTML/DOCX 采用无脚本净化预览；桌面高风险重放改为主进程原生确认，旧流程的键入内容会被清除并隔离；同步只发送脱敏的 `settings.json`；Native Worker 写入会拒绝工作目录外及包含符号链接/reparse point 的路径。声明式扩展 HTTP 权限改为解析后的 scheme、host、port 与路径边界校验，拒绝用户信息 URL 与全网通配。原始 Shell 文本规则不能再跳过批准，且即使渲染层返回批准，Bash、Shell、PowerShell、Monitor 仍须由主进程显示每次原生命令确认窗；显示文本会掩码常见密钥值。

发布侧已要求签名变量存在，并对生产依赖执行 high/critical 审计；所有 GitHub Actions 已固定到验证过的完整 commit SHA。CLI 使用随机私有运行目录和随机端点，并以一次性 256 位令牌完成首帧认证；Worker 在绑定 Unix socket 前验证父目录不是链接，清理时拒绝符号链接/reparse point。macOS 的 Unix socket 改用短私有 `/tmp` 目录以避免长度限制，Windows 命名管道使用 `CurrentUserOnly`。RDP TLS 验证已强制启用。SSH 已改为 `StrictHostKeyChecking=yes`，未知或已变化的主机指纹会在认证前被阻断；固定的连接复用目录会拒绝链接并强制 0700，权限修复失败时禁用复用。

控制面现已在 PostgreSQL 路径中直接使用 `organizations`、`organization_members`、`organization_applications` 与 `model_configs`；团队、成员、申请和模型授权不再从 JSON 快照恢复或写入。首次升级会在事务内迁移旧快照中能够严格映射到现有账户的数据；任一组织所有者或申请者无法映射时整体回滚，控制面与团队模型网关返回 503，避免静默丢失授权。迁移不保留旧自定义 provider 地址或凭据。模型默认项的切换在事务内锁定组织并原子更新，并由 PostgreSQL 部分唯一索引强制每个团队最多一个默认项。账户、设备和控制面 ID 统一为 UUID v4，以匹配 PostgreSQL 的主键与外键列；新增回归测试防止 ID 格式再次漂移。JSON 快照仅保留 Mesh 节点公开元数据。

复核通过：`npm run build`、`npm run verify:ci-core`、`npm run typecheck`、`npm run lint -- --max-warnings=0`、`go test ./...`、`.NET Worker build`、`npm audit --omit=dev --audit-level=high`、发布门禁及 IPC/WebView/权限策略验证。质量工作流现通过固定 SHA 的 `actions/setup-go` 运行 `server/go test ./...`，使控制面和 Mesh 回归成为发布门禁。另以临时本地 PostgreSQL 实例启动远程服务，确认架构迁移可执行、默认模型唯一索引存在，并确认新增账户写入 UUID v4。

凭据目录现在强制为 0700，凭据文件使用 0600；Linux `basic_text` 后端不会持久保存长期凭据。同步脱敏额外覆盖 bearer、session 与 ID token 变体，并有核心回归脚本防止这些字段重新进入同步载荷。

复审期间还发现 Feishu 附件与远程图片下载器可接受任意 HTTP URL、未验证重定向且没有响应大小上限。这会使来自渠道或渲染器的 URL 成为 SSRF 与内存耗尽入口。下载器现仅允许 HTTPS/443、无 URL 用户信息的公网目标；每次请求都先解析 DNS 并固定连接到已验证的公网 IP，同时保留原主机名作为 TLS SNI。私网、回环、链路本地、保留与多播地址均被拒绝；重定向重新经过相同检查，最多三次，响应限制为 25 MiB、超时 30 秒。`verify:network-download-safety` 已加入核心 CI 门禁。

渠道远程文件读取和二维码预览现在也统一使用该安全下载器。二维码不再通过隐藏 BrowserWindow 加载远程 HTML、解析 HTML 图片链接或执行第二次未受限下载；仅接受已验证下载器获得的图片字节。内联二维码仅允许 PNG/JPEG/GIF/WebP 的 Base64 数据，编码长度最多 4 MiB。

Mesh 发布事件现必须由已登记源节点的 Ed25519 私钥签名，服务端会对完整事件边界（协议版本、事件/源/目标/会话 ID、序号、类型及原始 payload 字节哈希）验证签名。该格式不依赖 Go 与 Node 的 JSON 重新序列化，避免 Unicode/HTML 转义差异造成验签失配。伪造或被修改的事件在入队前以 403 拒绝；Mesh 仍只允许低风险状态事件，并未重新开放远程执行。

能力票据的 nonce 现为单次消费：服务端在事件成功入队时以票据 ID 和 nonce 记录使用状态直至票据过期。同一个 `eventId` 可以安全重试并返回原事件；同一票据用于第二个事件则被拒绝，避免截获的短期票据被重复利用。该重放账本在当前状态事件封锁期保留于内存，后续会与加密持久队列一并迁入事务存储。

Mesh 事件读取现额外要求短期设备令牌。服务端验证 `X-Ola-Device-Token` 的账户与设备 ID 必须匹配目标节点；桌面端只为自身已注册节点请求该令牌。这样同一账户的另一台设备无法仅靠账户令牌读取目标设备的事件。

渠道上下文的每一次工具调用现均由 Worker 强制进入批准流程，不能被自动批准规则覆盖。仍须在后续平台重构完成后才可宣称完成全部原计划：CLI 对端身份握手与平台 ACL、渠道策略不可放宽的 Worker 强制机制、命令参数 schema、Mesh 持久加密队列与撤销，以及受限扩展运行时。它们没有在本轮被标记为已完成。
