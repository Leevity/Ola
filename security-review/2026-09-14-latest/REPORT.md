# Ola 1.0.5 安全性审查报告

审查日期：2026-09-14
审查对象：`main`，提交 `bc66e5ac683a9be8560dc55cd3f2729386ab8e11`（`origin/main`）
范围：Electron 主进程、Preload/Renderer、Native Worker、远端 Go 服务、Mesh、CLI、CI/CD 与生产依赖。

> 此文档记录修复前的审查基线，不能作为当前工作树的安全结论。已实施的修正、验证结果和仍待完成的架构项见同目录的 `REMEDIATION.md`。

## 结论

当前版本不适合在未修复下列 P0/P1 问题前向不受信任用户开放团队模型、第三方扩展、HTML/DOCX 预览、远程 Mesh Shell 或发布公开安装包。主要风险集中在“高权限能力由低信任输入驱动”：团队管理员可改变服务端请求目标；渲染层内容可执行脚本；桌面操作批准由渲染层布尔值决定；本地和远程执行通道缺少独立的能力证明。

| 优先级         | 数量 | 结论                                                                      |
| -------------- | ---: | ------------------------------------------------------------------------- |
| P0（立即阻断） |    2 | 可泄露服务器模型密钥或允许已安装扩展突破进程隔离。                        |
| P1（高）       |    7 | 可导致本地代码/桌面操作、未授权网络访问、远程命令执行或供应链完整性下降。 |
| P2（中）       |    7 | 影响凭据保护、租户隔离、可用性、审计与恢复能力。                          |

风险等级基于攻击前置条件、可获得的权限和影响评定；未发现表明代码库或当前机器已经被入侵的证据。

## 已完成的同步与验证

- 已执行 `git fetch origin`，本地已切换并对齐 `main -> origin/main`；`package.json` 版本为 `1.0.5`。
- `v1.0.5` 标签之后，`main` 还有 33 个提交；本报告审查的是远端 `main` 的最新代码，而非旧标签快照。
- 18 个现有静态验证脚本均通过，包括 IPC 授权、权限策略、WebView、发布门禁、远程凭据租约和运行时所有者隔离。
- 服务端执行 `go test ./...` 通过。
- `npm audit --omit=dev --package-lock-only`：6 个生产依赖漏洞（4 高、2 中）；.NET 依赖漏洞查询未返回已知漏洞。
- 未运行完整 Electron UI 冒烟测试：工作目录的 `node_modules` 与最新锁文件不一致（例如已装 Electron 36，而锁文件为 Electron 43），直接运行会产生不可信结论。

## 发现与修复建议

### P0-01 团队模型配置可把服务器全局 API Key 发送到攻击者地址

**证据**：[`server/internal/httpapi/control_plane.go`](../../server/internal/httpapi/control_plane.go) 的模型配置接口允许团队管理员提交任意 `baseUrl`，且 `apiKey` 可为空（312–358 行）。团队请求随后经 [`model_handlers.go`](../../server/internal/httpapi/model_handlers.go) 传入网关；[`gateway.go`](../../server/internal/modelgateway/gateway.go) 的 `config()` 会在覆盖配置的 API Key 为空时回退至 `OLA_MODEL_API_KEY`（118–128 行），并在 94–101 行向该 `baseUrl` 发送带 `Authorization: Bearer <全局密钥>` 的请求。

**影响**：已获批准团队的管理员可配置攻击者控制的 HTTPS/HTTP 端点并省略密钥，诱使任意团队成员发起对话请求。服务端会向该端点发送全局模型服务密钥；同时该接口也构成 SSRF，可访问服务端可达的内部地址。

**修复**：

1. 将“未提供覆盖配置”和“明确提供空密钥”建模为不同状态。只在未选择团队模型时使用全局默认配置；选择团队模型后，缺少有效凭据必须返回 503，绝不可回退。
2. 仅允许预登记的 HTTPS 提供商 Origin；解析 URL 后拒绝私网、回环、链路本地、Unix socket、重定向和 DNS 重绑定目标。使用固定 provider adapter，而非让租户提交自由 URL。
3. 将凭据写入服务端密钥库，模型记录只保存密钥引用；记录操作者、变更前后目标和审批事件。立刻轮换 `OLA_MODEL_API_KEY`，因为是否已被导出无法从现有日志可靠判断。

### P0-02 JavaScript 扩展并非安全沙箱

**证据**：[`src/main/ipc/extension-js-runtime.ts`](../../src/main/ipc/extension-js-runtime.ts) 以 Node `vm` 执行扩展代码。该运行时向上下文传入宿主对象（例如 `console`），而 `vm` 不是安全边界。审查中的本地探针可借由宿主函数构造器得到 `process`。扩展安装/更新一旦被社工、篡改或恶意插件利用，即可达到主进程权限。

**影响**：读取用户数据、执行命令、访问 IPC 和泄露所有已配置服务凭据。

**修复**：在完成替代方案前禁用本地 JS 扩展执行。将扩展迁移到独立、受限的子进程或 WASM runtime：无 Node 内建模块、无宿主函数、按能力授予 IPC、固定消息协议、资源/网络/CPU 限额。安装包应签名并显示发布者、哈希与所需权限；`node:vm` 只能用于隔离可信代码，不能作为安全沙箱。

### P1-01 HTML/DOCX 预览可执行不受信任脚本

**证据**：HTML 预览把内容赋给 `srcdoc`，同时启用 `sandbox="allow-scripts allow-same-origin"`，见 [`html-viewer.tsx`](../../src/renderer/src/lib/preview/viewers/html-viewer.tsx) 17–30 行。DOCX 预览把 Mammoth 产生的 HTML 直接写入 `dangerouslySetInnerHTML`，见 [`docx-viewer.tsx`](../../src/renderer/src/lib/preview/viewers/docx-viewer.tsx) 8–12、79–82 行。DOCX 可通过邮件附件、项目文件或 SSH 远程工作区到达该代码路径。

**影响**：恶意文件可在受信任渲染器上下文运行脚本，进而滥用暴露的桥接 API；它还能绕过下文的桌面流程批准设计。

**修复**：HTML 预览移除 `allow-same-origin`，采用独立的无权限 origin，默认禁止脚本；如确需交互，用严格 schema 的 `postMessage` 桥。DOCX 使用成熟 HTML sanitizer（严格允许元素、属性、URL 协议），并将所有外链、图片和样式隔离。为恶意 HTML、`javascript:` 链接、SVG、DOCX 超链接加入回归测试。

### P1-02 桌面高风险操作的“批准”可由渲染层伪造

**证据**：[`desktop-flow-handlers.ts`](../../src/main/ipc/desktop-flow-handlers.ts) 只要调用方提供 `args.approved === true` 即允许高风险步骤（166–177 行），之后直接调用鼠标、键盘和滚动控制（209–230 行）。这是一个普通 IPC 参数，而不是主进程验证过的用户确认。

**影响**：一旦渲染器遭 XSS、恶意扩展影响或出现逻辑缺陷，可直接伪造批准并向任意前台应用输入文本、点击和快捷键。

**修复**：高风险步骤必须在主进程显示不可由渲染器伪造的原生确认窗，显示目标应用、步骤摘要和敏感文本掩码。确认生成一次性、绑定 flow 哈希/窗口/过期时间的 capability token；主进程只接受该 token。保存和重放前对文本做密钥/密码模式检测，默认不录制敏感输入。

### P1-03 CLI 到 Native Worker 的 IPC 端点可预测且无认证

**证据**：[`cli/src/index.ts`](../../cli/src/index.ts) 用 PID 构造 `/tmp/ola-cli-<pid>.sock` 或 Windows 命名管道（32–35 行），随后直接连接（52–87 行）。协议没有随机后缀、私有运行目录、对端凭据检查或启动时密钥握手。

**影响**：同一台机器上的攻击者可抢占或竞态连接该端点，伪装 Worker，读取 `agent/run` 参数中的提供商配置，或伪造结果。Windows 命名管道也存在同类命名冲突风险。

**修复**：用至少 256 位随机值命名端点，放进权限为 0700 的专用运行目录；Windows 使用受限 DACL。父进程通过继承的匿名管道或只存在内存中的随机会话密钥完成双向认证，再接受业务帧；清理 socket 时防止符号链接/替换攻击。

### P1-04 Mesh 远程 Shell 缺少最小授权与资源限制

**证据**：[`server/cmd/ola-node/main.go`](../../server/cmd/ola-node/main.go) 启用 `--enable-shell` 后直接执行 `exec.CommandContext(..., "/bin/sh", "-c", command.Command)`（101–125 行）。能力票据由任何持有同一账户 JWT 的调用方申请，只校验目标节点声明了该能力，见 [`mesh.go`](../../server/internal/httpapi/mesh.go) 327–366、420–430 行；事件未由源节点私钥签名。输出在命令结束后才截断（122–129 行），`yes` 等命令可先占满内存。

**影响**：账户 token 泄露或同账户恶意客户端可在声明 shell 能力的节点执行任意命令；命令来源不可密码学追溯，且可造成节点内存耗尽。

**修复**：默认移除远程 shell，改为声明式、参数化的受限任务。若必须保留：每条高风险任务在目标节点本地确认；源节点对完整事件信封签名并由目标验签；票据绑定事件哈希、单次 nonce、目标、最小能力和短 TTL；用 cgroup/job object、无网络/最小权限账户、工作目录 allowlist 执行。流式读取输出且设置字节上限、CPU/内存/PID/文件大小限制；密钥和账户 token 不应通过命令行传入。

### P1-05 扩展网络 allowlist 可被前缀混淆绕过

**证据**：[`extension-js-runtime.ts`](../../src/main/ipc/extension-js-runtime.ts) 对以 `*` 结尾的规则使用 `target.href.startsWith(...)`（161–184 行）。例如允许 `https://api.example.com*` 时，`https://api.example.com.evil.invalid/` 与 `https://api.example.com@evil.invalid/` 均会通过字符串前缀判断。

**影响**：扩展可绕过网络域名限制并向攻击者端点发送请求或扩展配置数据。

**修复**：解析后比较 scheme、hostname、port 和规范化 path。只支持明确语义的 `https://host`、`https://*.example.com`、`https://host/path/*`，并拒绝用户信息、非默认端口和 IP 字面量，除非明确授权。为 URL 编码、子域、`@`、大小写、IPv6 和重定向加入表驱动测试。

### P1-06 插件通道权限没有可靠传递到 Native Worker

**证据**：[`use-plugin-auto-reply.ts`](../../src/renderer/src/hooks/use-plugin-auto-reply.ts) 明确丢弃 `permissions`（804–808 行），并把请求交给侧车运行时；旧的按通道工具限制因此不再是强制边界。现有验证覆盖 IPC 调用方，但没有证明插件通道的工具集、审批策略和文件根目录在 Native Worker 内被等价约束。

**影响**：消息渠道或插件中收到的提示可能获得比预期更广的工具调用能力，形成提示注入到本地操作的路径。

**修复**：把不可变的渠道策略、会话来源、允许工具、文件根和审批要求纳入主进程签名的运行请求；Native Worker 对每次工具调用重新强制检查。策略只可收紧不可放宽，并为每个渠道加入拒绝型集成测试。

### P1-07 发布流程允许公开发布未签名安装包

**证据**：[`build.yml`](../../.github/workflows/build.yml) 的近期提交已将 Windows/macOS 签名缺失从发布阻断改为允许未签名包继续。审查 `v1.0.5..main` 的提交包含 `allow unsigned windows packages` 与 `allow unsigned macos packages`。

**影响**：用户无法稳定验证下载的桌面安装包来源；更新链、镜像站或发布账号被攻击时，篡改包更难被发现。

**修复**：公开 Release 必须强制 Windows Authenticode、macOS Developer ID + notarization；缺少签名凭据时只能生成内部测试工件，不能上传或发布。补充 SBOM、构建证明（provenance）、工件 SHA-256 和签名验证门禁；GitHub Actions 使用提交 SHA 固定版本，发布权限仅授予发布 job。

### P2-01 团队控制面状态未实际持久化，模型列表读取无成员鉴权

**证据**：[`control_plane.go`](../../server/internal/httpapi/control_plane.go) 的 `teams`、`members`、`applications`、`models` 均为未导出字段（64–70 行）；`persistLocked()` 对该结构做 `json.Marshal`（135–150 行），Go 不会序列化未导出字段。因此服务重启后团队、成员和模型配置会丢失。另有 GET `/api/control/models?teamId=...` 直接读取列表，无成员/系统管理员检查（312–321 行）。

**影响**：服务重启导致权限和模型配置消失，进而触发全局默认模型回退或业务中断；同一服务的任意已登录用户可按 team ID 枚举模型元数据。

**修复**：将状态迁入已设计的数据库表，或使用显式的持久化 DTO（仅密钥引用、绝不含 API Key）；为读取和写入统一做成员/系统管理员授权。将重启恢复、跨租户读取拒绝、邀请注册后成员绑定作为集成测试。

### P2-02 密钥和同步数据的静态保护不足

**证据**：设置、SSH 配置和部分凭据仍可写入本地 JSON/SQLite；WebDAV 同步包含配置数据但没有端到端加密设计。`safeStorage` 在某些 Linux 环境可能退化为 `basic_text`，而现有流程未在此状态下阻断凭据持久化。

**影响**：本机其他有权限的进程、备份介质或 WebDAV 服务端可能获得 provider key、SSH 密码、访问 token 和会话数据。

**修复**：密钥统一进入操作系统钥匙串；`basic_text` 模式下禁止保存长期密钥或要求用户提供本地主密码。同步层采用客户端生成密钥的端到端加密、版本化密钥轮换和加密元数据最小化；默认排除 SSH 密码、OAuth refresh token、模型 key 与桌面流程文本。

### P2-03 SSH 主机身份与 RDP TLS 验证应默认强制

**证据**：SSH 连接路径没有统一强制的主机指纹验证；RDP 代码存在 `rejectUnauthorized: false` 的 TLS 放宽分支。

**影响**：首次连接或网络被劫持时，攻击者可冒充远端主机，窃取登录凭据、命令和文件。

**修复**：SSH 实现 TOFU 加明确指纹展示、变更阻断和 known_hosts 管理；RDP 默认验证证书/主机名，仅允许用户在单次连接中做可审计例外，禁止全局关闭验证。

### P2-04 工作区路径检查未解析符号链接

**证据**：Native Worker 多处以 `Path.GetFullPath` 与字符串前缀判断工作区边界。若工作区内有指向外部敏感目录的符号链接，词法路径仍在工作区内。

**影响**：文件工具可在用户批准的工作区范围之外读取或写入文件。

**修复**：对已存在路径解析真实路径并对每个父目录检查 reparse point/symlink；创建文件时逐段以安全句柄打开，拒绝链接或跨根跳转。用 macOS/Linux symlink 和 Windows junction 写入做回归测试。

### P2-05 Shell allowlist 基于文本模式，不能表达 shell 语义

**证据**：命令策略对 shell 字符串做模式判断。重定向、子命令、环境变量展开、管道和不同 shell 的解析规则会使“允许某命令”的含义扩展为更多副作用。

**影响**：看似低风险的允许规则可能覆盖写文件、网络访问或额外命令。

**修复**：将允许规则改为可执行文件绝对路径 + 参数 schema，使用 `spawn`/`ProcessStartInfo.ArgumentList`，避免 shell。确需 shell 的规则一律高风险、逐次确认并记录完整命令和执行上下文。

### P2-06 桌面自动化流程可持久保存敏感输入

**证据**：[`desktop-flow-store.ts`](../../src/main/desktop/desktop-flow-store.ts) 允许步骤包含最长 100,000 字符的 `text`（42–54 行），并将整个 flow JSON 写到磁盘（84–94 行）。文件权限为 0600 是必要保护，但不能解决已录入密码、令牌或个人数据后被同步、备份、恶意同用户进程读取的问题。

**修复**：录制默认不采集键入文本；使用 OS 安全输入字段检测和 secret pattern 检测，命中后只保存占位符并在重放时从钥匙串临时填充。目录显式 0700，增加加密和清除策略，并在 UI 显示保存的数据分类。

### P2-07 Mesh 队列不持久化且响应序号存在竞争

**证据**：Mesh 事件被刻意排除在控制面持久化之外（[`control_plane.go`](../../server/internal/httpapi/control_plane.go) 72–77 行），服务重启即丢失未送达事件。`ola-node` 通过先读列表再计算最大序号（145–156 行）分配响应序号，多个并行响应可竞争并在实际命令执行后发布失败。

**修复**：使用加密的持久消息队列和幂等事件 ID；由服务端以原子递增分配每会话序号。保留最少必要的审计元数据，敏感 payload 加密且设置短期保留；为重启、重投、并发响应和撤销能力票据建立测试。

## 建议实施顺序

**0–72 小时：** 下线或限制团队自定义 provider URL；修复空密钥回退并轮换全局模型密钥；暂停 JS 扩展执行；关闭未修复的 HTML/DOCX 预览脚本能力；禁用 Mesh Shell；将高风险桌面流程切换为原生确认；不发布未签名公开安装包。

**第 1 周：** 修复 CLI IPC 握手、扩展网络规则、插件侧车策略传递；完成 `npm audit` 中 6 个生产依赖的升级/替换与锁文件验证；实施 SSH/RDP 证书校验；为上述 P0/P1 建立攻击回归测试。

**第 2–4 周：** 完成团队/模型控制面数据库化与租户鉴权，建立密钥库与端到端加密同步；收紧文件系统和 shell 执行模型；为 Mesh 加入签名、审计、配额、撤销和安全任务执行器。

## 架构与功能设计缺口

1. **缺少统一的能力安全模型。** 目前权限判断分散在渲染器、主进程、Native Worker、Go 服务和客户端。应定义统一 capability contract：来源、主体、资源、动作、范围、过期、批准、审计 ID，并由最终执行进程验证。
2. **缺少不受信任内容边界。** 文件预览、扩展、渠道消息、远程事件都可携带攻击者控制内容。应按“数据只读、可渲染、可执行”三级分类，默认仅数据只读。
3. **缺少密钥生命周期管理。** 需要密钥库存储、最小化暴露、轮换、撤销、审计和泄露响应，而不是把 key 视作普通配置字段。
4. **缺少安全发布基线。** 公开工件必须有签名、SBOM、可追溯构建证明、依赖漏洞阻断阈值和可复现的安全回归套件。
5. **缺少多租户与远程执行威胁模型。** 团队、Mesh 节点和模型 provider 都应明确所有者、委托链、撤销语义和服务重启后的恢复语义。

## 复测通过条件

- 团队自定义 `baseUrl` 无法访问私网/攻击者地址，且空 API Key 永不发送全局密钥。
- 恶意 HTML、DOCX、扩展脚本和网络 allowlist 绕过样本均不能取得 renderer/main/worker 权限。
- 伪造 `approved: true` 不能驱动高风险桌面操作；只有主进程签发的一次性令牌可执行。
- 同用户恶意进程不能连接或伪造 CLI Worker IPC。
- Mesh 远程任务必须有可验证源签名、目标本地批准、资源限额和可审计事件链。
- 服务重启后团队成员、授权和非敏感模型元数据保持一致；跨团队读取返回 403。
- 公开 Release 无签名、无 SBOM、存在超过阈值的依赖漏洞时必定失败。
