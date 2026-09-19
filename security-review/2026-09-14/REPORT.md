# Ola 全项目安全审查与优化方案

审查日期：2026-09-14。基线：`4df9b262bc46e60fe6324fa90cc3c2e040acec39`，应用版本 `1.0.4`。审查开始时工作区干净；本次仅新增审查资料，没有修改业务代码、安装依赖或访问用户真实凭据。

## 1. 需要优先处理的结论

当前最需要修复的是**外部内容可以进入高权限执行环境，而部分权限声明没有在执行端形成强制限制**。建议把以下问题作为下一次对外发布前的安全阻断项：扩展 JS 隔离逃逸、HTML/DOCX 预览与主界面隔离、频道权限在 Native Worker 中的执行缺口，以及同步密钥暴露。

本次按完整仓库范围梳理入口，并深入追踪高风险链路；这不是对 1,937 个受版本控制文件逐行验证，也不是生产环境渗透测试。报告中的“已复现”仅指具体说明的本地实验，不代表已在打包应用、全部操作系统和生产部署中复现完整攻击链。

| 编号 | 优先级 | 问题                                                | 证据状态                             |
| ---- | ------ | --------------------------------------------------- | ------------------------------------ |
| F01  | P1     | 扩展 JS 使用主进程 `vm`，可访问宿主 `process`       | 当前源码提取、本地复现               |
| F02  | P1     | HTML 预览同时允许脚本与同源访问                     | 可达代码链确认；浏览器实验超时       |
| F03  | P1     | DOCX HTML 未净化，可保留可执行链接                  | 本地构造文档验证转换结果             |
| F04  | P1     | 频道权限没有传递到 Native Worker 的实际文件执行路径 | 跨层代码链确认                       |
| F05  | P1     | ssh2 连接不验证主机密钥                             | 实现与上游默认行为确认               |
| F06  | P2     | RDP TLS 桥无条件关闭证书验证                        | TLS 层确认；未做完整 RDP 中间人测试  |
| F07  | P1     | Provider、SSH 等敏感配置以明文持久化                | 写入链确认，未读取真实配置           |
| F08  | P1     | WebDAV 同步上传含密钥配置，缺少端到端加密           | 捕获、序列化、上传链确认             |
| F09  | P2     | Linux 凭据库未识别 `basic_text` 弱后端              | 代码与官方行为确认；未实测 Linux     |
| F10  | P1     | 工作目录写入审批可被符号链接绕过                    | 路径模型复现，未运行 Worker 写入攻击 |
| F11  | P2     | Shell 放行规则没有约束重定向副作用                  | 直接执行当前权限函数复现             |
| F12  | P2     | 扩展网络通配规则按 URL 字符串前缀匹配               | 当前源码提取、本地复现               |
| F13  | P1     | 应用依赖存在已知高风险告警，文档解析具有可达入口    | 在线审计与调用点确认；未逐项验证利用 |

这里的 P1/P2 是项目整改优先级，不等于 CVSS。未认定无条件远程接管的 P0 问题。攻击者通常需要让用户安装/运行扩展、预览外部文件、向已连接频道发送消息，或处于网络中间人位置。

## 2. 具体问题、影响及修复验收

### F01 — P1：扩展 JavaScript 隔离可逃逸到主进程

**位置：** [src/main/ipc/extension-js-runtime.ts:343](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/extension-js-runtime.ts:343)、[src/main/ipc/extension-js-runtime.ts:388](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/extension-js-runtime.ts:388)。

扩展入口文件由 `vm.Script` 在 Electron 主进程执行。沙箱隐藏了 `require`、`process`，但直接暴露宿主 `console` 和函数，并启用字符串代码生成。提取当前 `createSandbox` 后，以下无破坏性表达式返回 `object`：

```js
console.log.constructor('return typeof process')()
```

这证明代码获得了宿主上下文的访问能力。未读取环境变量、文件或运行系统命令。恶意扩展在运行时可以绕过仅由 `ctx.fetch` 实施的网络限制；与宿主对象相连的代码不能被视作受限扩展。现有 1 秒入口超时和 30 秒 Promise 超时不构成权限隔离，后者也不等价于终止后台计算与网络请求。

**修复：** 将扩展移出 Main，采用独立进程及操作系统级文件、网络和进程权限限制；所有网络/存储通过经过鉴权的 broker。不要把删除 `console`、禁用字符串生成或改用普通 Worker Thread 当作最终安全边界。短期可以先限制为明确受信任的 JS 扩展，并在启用前展示其真实系统权限。

**验收：** 恶意扩展不能访问宿主对象、非授权文件或直接联网；超时能够杀死整个扩展执行实例；扩展崩溃不影响主进程。Node 官方明确说明 `vm` 不是安全机制。[Node.js 文档](https://nodejs.org/api/vm.html)

### F02 — P1：HTML 预览可以与主界面同源执行

**位置：** [src/renderer/src/lib/preview/viewers/html-viewer.tsx:16](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/preview/viewers/html-viewer.tsx:16)、[src/renderer/src/lib/preview/viewers/html-viewer.tsx:28](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/preview/viewers/html-viewer.tsx:28)、[src/preload/index.ts:27](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/preload/index.ts:27)。

用户预览项目或外部 HTML 时，内容进入 `srcdoc`，iframe 同时具有 `allow-scripts allow-same-origin`。该组合使预览内容与父页面保持同源关系，具备访问父窗口 DOM/对象的条件。父页面又暴露了通用 IPC API；当前 CSP 允许内联脚本。

攻击链为：恶意 HTML → 预览脚本 → 父页面对象/IPC → 应用高权限能力。仅检查“IPC 来自应用窗口主 frame”的机制不能充分抵御通过父页面自身桥接函数发出的调用。这里未执行真实 IPC 攻击；独立 Chrome 验证在本机超时，因此明确保留打包 Electron 回归要求。

**修复：** 默认只保留 `allow-scripts`，让预览具有独立 opaque origin；更高兼容性需求使用独立 origin/独立隔离窗口，通过最小化 `postMessage` 协议交换数据。关闭顶层导航，拦截非预期应用窗口导航，逐步去掉通用 IPC 暴露。

**验收：** HTML 无法读取 `parent.document`、父页面桥接对象、会话数据；不能通过父页面代发文件/终端 IPC。分别覆盖开发环境和 `file://` 打包环境。[MDN iframe 安全说明](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

### F03 — P1：DOCX 转换后的 HTML 直接进入主渲染器

**位置：** [src/renderer/src/lib/preview/viewers/docx-viewer.tsx:8](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/preview/viewers/docx-viewer.tsx:8)、[src/renderer/src/lib/preview/viewers/docx-viewer.tsx:81](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/preview/viewers/docx-viewer.tsx:81)。

`mammoth.convertToHtml` 的返回值直接交给 `dangerouslySetInnerHTML`，没有净化或独立文档隔离。本地构造仅包含 `javascript:void(0)` 超链接的 DOCX，当前安装版本输出：

```html
<p><a href="javascript:void(0)">Audit harmless link</a></p>
```

因此，外部 DOCX 中的主动内容可被带入应用主文档。当前 CSP 的 `unsafe-inline` 增加点击可执行链接的风险。此实验只验证转换保留危险 URL，没有执行窃取行为；不能据此宣称任意 DOCX 一打开便执行代码。

**修复：** 转换后使用维护中的 HTML sanitizer，严格限制标签、属性和 URL scheme；链接仅允许明确协议并经主进程安全打开。优先在无同源能力的 iframe 内展示转换结果，禁用脚本。远程图片是否自动加载应有明确隐私策略。

**验收：** `javascript:`/混淆 URL、事件属性、SVG、危险嵌入均被清理；安全普通文档格式正常。转换库官方说明自身不净化不可信文档。[Mammoth 安全说明](https://github.com/mwilliamson/mammoth.js#security)

### F04 — P1：频道权限迁移后没有在执行端生效

**位置：** [src/renderer/src/hooks/use-plugin-auto-reply.ts:465](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/hooks/use-plugin-auto-reply.ts:465)、[src/renderer/src/hooks/use-plugin-auto-reply.ts:653](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/hooks/use-plugin-auto-reply.ts:653)、[src/renderer/src/hooks/use-plugin-auto-reply.ts:799](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/hooks/use-plugin-auto-reply.ts:799)、[src/renderer/src/lib/ipc/sidecar-protocol.ts:513](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/ipc/sidecar-protocol.ts:513)、[sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:597](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:597)。

频道 UI 提供 `allowReadHome`、`readablePathPrefixes`、`allowWriteOutside`、`allowShell`。自动回复读取这些设置后却执行 `void permissions`，构造完整工具目录，运行请求没有频道权限字段。Native Worker 的 `ReadAsync` 根据路径直接读取文件，其审批决策对 Read 默认返回 false，也没有查询频道读取范围。

**具体触发：** 开启频道自动回复，配置不允许读取主目录；频道消息诱导模型调用工作目录外的 Read。当前执行路径没有对应强制限制，返回内容可能进入模型请求或回复。Shell 仍有普通审批，不能因此声称所有命令完全无审批；但“频道禁止”没有形成独立于全局自动审批/白名单的硬拒绝。

**修复：** Main 根据可信 `pluginId` 加载并冻结频道策略，Worker 必须在工具执行前校验；禁止通过 renderer 自报权限扩大范围。每个频道默认仅可访问绑定工作目录；Read/Search/Write/Shell/SSH/MCP/扩展和子任务继承同一权限上下限。

**验收：** 用假模型直接返回越界工具调用，验证即使提示词要求放行、开启全局自动审批或转交子 Agent，也不能违反频道 deny。另加“允许用户/群组”和管理员命令授权机制，频道身份不能只等于机器人可接收消息。

### F05 — P1：SSH 客户端缺少主机密钥验证

**位置：** [src/main/ipc/ssh-handlers.ts:542](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/ssh-handlers.ts:542)、[src/main/ipc/ssh-handlers.ts:888](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/ssh-handlers.ts:888)。

`buildConnectConfig` 设置主机、用户名、密码/私钥等，但没有 `hostVerifier`。直连与跳板机均沿用该配置。ssh2 默认在没有 verifier 时接受主机密钥，因此中间人或伪造目标可冒充 SSH 主机，获取密码认证内容或篡改会话。使用私钥不意味着私钥文件会被直接传给攻击者，报告不作这种推断。

Native OpenSSH 另一路使用 `StrictHostKeyChecking=accept-new`，说明两条执行路径安全语义不一致；该保护不能覆盖 ssh2 终端路径。

**修复：** 统一 known_hosts/主机指纹存储，首次连接展示并确认指纹，变更默认拒绝，跳板与目标分别验证；企业部署支持预置可信指纹或主机证书。

**验收：** 主机 A 成功连接后换为主机密钥 B，必须在发送认证信息前拒绝；终端、跳板、SFTP、Worker 路径行为一致。[ssh2 官方连接选项](https://github.com/mscdex/ssh2#client-methods)

### F06 — P2：RDP 桥无条件忽略 TLS 证书可信性

**位置：** [src/main/remote/rdp/rdp-cleanpath-bridge.ts:185](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/remote/rdp/rdp-cleanpath-bridge.ts:185)。

TLS 升级硬编码 `rejectUnauthorized: false`，并限制 TLS 1.2/RSA 套件以兼容特定主机。后续检查证书存在、转发证书链不等于验证可信身份。当前 TypeScript 路径未见主机指纹持久化与变更拒绝。

这是已确认的 TLS 层验证缺失；CredSSP/NLA 与 WASM 客户端完整链路未做中间人实验，不能据此断言已成功窃取 RDP 密码。

**修复：** 默认使用正常证书验证；自签名主机走明确指纹信任流程；兼容选项仅对指定连接生效，不全局降级。证书更换必须阻断并说明原因。

**验收：** 可信、自签名未信任、已固定指纹变更、过期证书分别测试；验证在提交凭据前完成。

### F07 — P1：敏感配置未统一纳入凭据库

**位置：** [src/renderer/src/lib/ipc/config-storage.ts:3](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/ipc/config-storage.ts:3)、[src/renderer/src/stores/provider-store.ts:1506](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/stores/provider-store.ts:1506)、[src/main/ipc/secure-key-store.ts:40](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/secure-key-store.ts:40)、[sidecars/Ola.Native.Worker/Modules/Config/ConfigStore.cs:186](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Config/ConfigStore.cs:186)、[sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs:402](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs:402)、[sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs:605](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Ssh/SshConfigStore.cs:605)。

Provider 列表整体持久化到 `config.json`，包含 API Key/认证配置；所谓 `secure-key-store` 当前是转发到 Native Worker 的 JSON 存储，没有加密。SSH 配置序列化包含 password，并以 `File.WriteAllText` 写入。相关写入没有显式建立私有目录/文件权限，实际权限依赖操作系统与 umask。

能读取这些文件的进程、备份接收者或意外收集的诊断包可能获得可重用密钥。并不意味着任何远程访客都可直接读取文件，也不意味着磁盘加密可以替代应用凭据隔离。

**修复：** 统一 SecretRef 模型，API Key、OAuth refresh token、SSH 密码/口令、频道密钥、WebDAV 密码进入系统凭据库；配置仅存引用。UI 返回 masked metadata，由 Main/Worker broker 按用途短期取用。迁移成功后去除旧字段，检查历史备份，不在日志打印原值。

**验收：** 使用假的 canary secret 保存全部认证类型，在应用配置、数据库、导出包和日志中搜索，不能出现明文；Unix 目录 0700/敏感文件 0600，Windows 使用用户级 ACL。

### F08 — P1：WebDAV 同步上传密钥且没有端到端加密

**位置：** [sidecars/Ola.Native.Worker/Modules/Sync/SyncFileStore.cs:13](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Sync/SyncFileStore.cs:13)、[sidecars/Ola.Native.Worker/Modules/Sync/SyncFileStore.cs:244](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Sync/SyncFileStore.cs:244)、[src/main/sync/sync-config.ts:117](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/sync/sync-config.ts:117)、[src/main/sync/webdav-provider.ts:337](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/sync/webdav-provider.ts:337)。

同步明确包含 `config.json`、`settings.json`、`plugins.json`。配置过滤仅排除 prompt-cache installation ID，Provider 配置与 WebDAV 自身的 password 并未移除。上传实现是 JSON → gzip → HTTP PUT，没有端到端加密。HTTPS 只能保护传输，WebDAV 服务及备份持有者仍可以解压读取。

此外，服务 URL 接受非本地 HTTP 并发送 Basic Authorization。配置这样的地址会同时暴露认证与同步内容。远端状态也能回写配置，需把同步服务被篡改视为安全边界，而不仅是冲突合并问题。

**修复：** 立即改为同步字段白名单，默认排除全部秘密及设备安全策略；普通配置同步与用户明确选择的加密密钥迁移分离。使用经过审查的 AEAD 加密方案，密钥不随数据上传，定义恢复/轮换流程；强制 HTTPS，必要的本地 HTTP 例外显式配置。对权限、MCP/扩展执行配置等高影响字段的远端变更要求本地重新信任。

**验收：** 假密钥不出现在解压后的同步包；服务端只能获得密文；篡改、错误密钥、截断包失败且不覆盖本地状态；同步不能静默扩大执行权限。

### F09 — P2：Linux safeStorage 的弱后端被误判为安全存储

**位置：** [src/main/credentials/secret-vault.ts:132](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/credentials/secret-vault.ts:132)、[src/main/credentials/secret-vault.ts:144](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/credentials/secret-vault.ts:144)。

当前只检测 `isEncryptionAvailable()`，没有检查 Linux `getSelectedStorageBackend()`。Electron 在 `basic_text` 后端可能使用硬编码密码加密，官方明确说明其不提供所期待的保护。代码注释承诺无密钥环时只保存在内存，但此检测不足以落实承诺。

**修复：** Linux 明确拒绝把 `basic_text` 当作可安全持久化后端；转为 session-only 或要求系统密钥环。恢复、锁屏、密钥环暂不可用时应避免把未成功解密的空缓存覆盖到现有 vault。

**验收：** Linux `--password-store=basic` 下不持久化密码，UI 显示 session-only；GNOME/KWallet 正常持久化；重启和密钥环暂时锁定不损坏已存凭据。[Electron safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage)

### F10 — P1：工作目录边界只比较字符串，未解析符号链接

**位置：** [sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:1188](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:1188)、[sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:631](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimeNativeToolExecutor.cs:631)。

Write/Edit 是否需要越界审批取决于 `Path.GetFullPath` + 前缀判断。`GetFullPath` 只规范化路径，不解析符号链接。工作目录下若存在指向外部目录的链接，`working/link/file` 被判定在范围内，而实际写入到外部。

本地临时目录验证了“词法范围内、真实路径范围外”；没有修改真实工作文件。写前读取一致性检查解决的是并发改动，不解决写入授权。另一个缺口是所有平台使用 `OrdinalIgnoreCase`：在区分大小写文件系统上可能混淆两个不同目录。

**修复：** 统一路径授权模块，解析所有已有路径组件以及新文件的父目录；使用符合平台语义的比较。阻止授权后到打开文件期间的 symlink/junction 替换；尽可能通过目录句柄/no-follow 或 OS sandbox 实施最终边界。

**验收：** 目录链接、文件链接、Windows junction、大小写相邻目录、缺失父目录和检查后替换场景全部覆盖，Read/Write/Edit/Notebook/搜索及 SSH 具有明确一致策略。

### F11 — P2：Shell 白名单把字符串匹配当作副作用许可

**位置：** [src/shared/permission-policy.ts:126](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/shared/permission-policy.ts:126)、[src/shared/permission-policy.ts:204](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/shared/permission-policy.ts:204)、[sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimePermissionPolicy.cs:245](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/AgentRuntime/AgentRuntimePermissionPolicy.cs:245)。

已有规则会拆分管道/连接符并拒绝部分嵌套展开，这是有效改进；但 `echo *` 放行规则会允许 `echo audit > /tmp/ola-example-only`。本次直接调用当前权限函数，结果为 `allow`，没有运行该 shell 命令。只读命令也可以通过输出重定向截断文件，且不受 Write 工具的工作目录边界控制。

这依赖用户配置此类允许规则，不是默认启用的无条件绕过。更广泛的 `python *`、`sh *`、构建命令也不能被安全地理解为有限操作。

**修复：** 对命令 AST 和重定向目标作权限判断；遇到未支持语法默认审批。分别定义工具可用性、命令批准、文件范围和网络范围，黑名单不能替代 OS 权限隔离。拒绝的操作不得被全局自动批准覆盖。

**验收：** 重定向、进程/变量展开、shell 启动器、PowerShell、cmd、嵌套脚本、后台命令覆盖；TS/.NET 策略用共享向量验证一致性。

### F12 — P2：扩展网络通配规则错误接受不同 origin

**位置：** [src/main/ipc/extension-js-runtime.ts:151](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/ipc/extension-js-runtime.ts:151)、[sidecars/Ola.Native.Worker/Modules/Extensions/ExtensionHttpToolExecutor.cs:330](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Modules/Extensions/ExtensionHttpToolExecutor.cs:330)。

带 `*` 后缀的规则直接比较完整 URL 前缀。规则 `https://api.example.com*` 会允许 `https://api.example.com.evil.invalid/x` 和 `https://api.example.com@evil.invalid/x`。本次提取当前 JS 函数验证两者均为 true，没有请求这些域名。明确写成 `https://api.example.com/*` 的规则不自动具有同一个 origin 混淆问题。

重定向逐跳检查已存在，但没有修复匹配函数本身；跨 origin 重定向沿用请求 headers，也应按凭据目的地约束，而不仅检查目标是否在某个 allowlist 中。

**修复：** 先解析并严格比较 scheme/hostname/port，再匹配路径；禁止 URL userinfo；子域通配只在 hostname 组件实现，路径匹配有边界。对跨 origin 重定向删除认证头，对敏感认证头绑定唯一 origin；增加 DNS/IP 私网策略和请求大小/时限。

**验收：** hostname 后缀混淆、userinfo、默认端口、编码路径、重定向、IPv4/IPv6、localhost/private IP 和 DNS 变化测试；JS/.NET 共用测试向量。

### F13 — P1：依赖漏洞治理没有与应用实际入口形成发布闭环

**证据：** 本目录 [npm-audit.json](/Users/lqy-macmini/Desktop/vibecoding/Ola/security-review/2026-09-14/npm-audit.json)、[npm-production-audit.json](/Users/lqy-macmini/Desktop/vibecoding/Ola/security-review/2026-09-14/npm-production-audit.json) 和 [dependency-summary.json](/Users/lqy-macmini/Desktop/vibecoding/Ola/security-review/2026-09-14/dependency-summary.json)；[package.json:172](/Users/lqy-macmini/Desktop/vibecoding/Ola/package.json:172)、[src/renderer/src/lib/preview/viewers/spreadsheet-viewer.tsx:67](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/renderer/src/lib/preview/viewers/spreadsheet-viewer.tsx:67)。

| 审计范围              | Critical | High | Moderate | Low | 合计 |
| --------------------- | -------: | ---: | -------: | --: | ---: |
| 根项目完整 npm 依赖树 |        2 |   43 |       11 |   3 |   59 |
| 根项目 `--omit=dev`   |        1 |   32 |        8 |   2 |   43 |
| 独立 CLI npm 依赖树   |        0 |    0 |        0 |   0 |    0 |

这是 npm 对受影响依赖项的统计，不是 59 条独立 CVE，也不是 59 个已验证可利用漏洞。传递依赖会因同一漏洞产生多项告警。Electron 声明为 devDependency，但被打包成最终运行时，不能因 `--omit=dev` 排除而忽略。

重点处理：

- `xlsx 0.18.5`：外部表格经过 `XLSX.read`，属于可达不可信输入入口；审计标记高风险原型污染/ReDoS 且 `fixAvailable: false`。不能仅依靠普通 `npm audit fix`，应更换为可维护且来源经过确认的分发版本或替代实现，并在独立解析进程中限制资源。[SheetJS 安全公告](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)
- `electron 36.9.5`：根审计报告高风险，需要制定受支持版本升级与 Electron/原生插件兼容矩阵；不直接把 audit 自动建议的跨 major 版本视作已验证方案。
- `ws 8.19.0`、飞书 SDK/传递 axios、`@toon-format/toon 2.1.0`、`electron-updater` 等：逐项确认调用入口、受影响功能、最低修复版本和兼容性。
- critical 条目来自 `protobufjs` 与 `tar`；分别审查运行时处理消息和安装/打包解压链路，不能不经调用分析直接认定应用可被远程执行代码。

**修复：** 锁定更新依赖，基于直接/传递、运行时/构建时、输入可控性分类；引入依赖自动更新、SBOM 对照、可到达性说明及带到期时间的例外。保持 CI 安装使用唯一可信锁文件。

**验收：** 所有可达高危输入路径完成修复或有效隔离；剩余 high/critical 有负责人、依据与截止时间，发布门禁自动验证。

## 3. 已有安全能力与覆盖情况

应保留和扩展现有有效控制，避免将当前问题误解为“完全没有安全设计”。

| 范围             | 已确认存在的控制                                                                                     | 仍需完善                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Electron/webview | contextIsolation、禁用 Node；内置 webview 强制 sandbox/webSecurity，删除 preload；浏览器权限默认拒绝 | 主界面 sandbox:false、CSP 较宽；外部文档预览没有统一隔离                    |
| IPC              | 文件/终端、SSH、凭据、远程控制等入口校验 sender/主 frame；部分资源绑定 owner                         | 通用 handler 没有默认鉴权；preload 暴露任意 channel；身份与能力授权混在一起 |
| Agent            | Worker 拒绝规则优先；审批事件；工具白名单；修改前读取一致性；取消与输出截断                          | 频道策略遗漏、路径边界、Shell 缺少 OS 隔离；不可仅靠提示词                  |
| 凭据             | SecretVault 使用 safeStorage、原子写、0600；凭据注入有授权检查；远程连接存引用                       | Provider/SSH/频道/同步认证未统一覆盖；Linux fallback                        |
| 远程服务         | bcrypt、限流、令牌过期/用途、撤销、配对与会话授权、消息大小限制、生产环境拒绝默认密钥                | 账户生命周期、多因素认证、设备撤销传播、运行监控和网关配置需加强            |
| 同步             | 冲突处理、条件写入、路径允许列表、备份                                                               | 密钥排除、E2EE、权限配置信任、压缩包资源限额                                |
| 发布             | typecheck/lint/format/verify 门禁；macOS 签名公证约束；产物校验、校验和和 SBOM                       | 安全行为测试、依赖/秘密扫描、Go/.NET 安全测试持续门禁                       |

Go 默认开发密钥已被 production 启动检查拒绝，因此**没有**把“配置中有开发密钥字符串”作为漏洞。webview 的强制隔离已经存在，因此**没有**认定内置浏览器默认启用了 Node。

## 4. 功能和架构缺失：建议形成统一安全模型

### 4.1 执行权限中心，而非分散的布尔开关

新增统一 `ExecutionPolicy`，由 Main 根据用户、会话、项目、频道与调用来源生成，Worker 不接受未验证的权限扩大。至少包含：读取根目录、写入根目录、允许网络目的地、可调用工具、允许的秘密引用、资源配额和有效期。

决策顺序固定为：可信来源及 owner → 强制 deny → 路径/网络/凭据能力检查 → 当前调用审批 → 执行。批准记录绑定 runId、toolCallId、规范化输入哈希、资源范围和期限，拒绝重放和审批后换参数。子 Agent、团队、cron 只能继承或缩小父任务权限。

提供“仅回复”“工作目录读写”“允许特定网络”“完整系统访问”等明确能力档位；Shell 的完整系统权限必须与有限文件工具权限区分。普通编码任务和外部频道任务不应共享无差别的自动批准语义。

### 4.2 外部内容统一渲染网关

HTML、DOCX、SVG、Mermaid、扩展 UI 和模型 widget 使用统一内容等级。普通静态内容净化后展示；主动内容进入独立 origin/受限进程；通信按 schema 验证，检查消息来源与窗口引用。不可信内容永远不能取得主界面的 IPC 对象。

逐步收紧生产 CSP：先消除业务对 `unsafe-inline`/`unsafe-eval` 的依赖，再移除；CDN 脚本改为本地受版本控制资产。主窗口导航采用确切应用 URL 白名单，新增窗口使用统一安全工厂。

### 4.3 SecretRef 全生命周期

统一新增、编辑、使用、锁定、删除、轮换与迁移协议。界面只得到引用和掩码，秘密在调用外部服务前按用途注入。API key 不应先完整返回 renderer 再回传 Main。记录“哪个任务何时使用哪类凭据访问哪个 origin”，不记录值。

明确日志/诊断导出的脱敏范围、保留期限与用户删除机制。历史会话可能含模型看到的敏感内容，凭据库加密并不能自动保护这些副本。

### 4.4 Native Worker 本地传输还需加固

[src/main/lib/native-worker.ts:608](/Users/lqy-macmini/Desktop/vibecoding/Ola/src/main/lib/native-worker.ts:608) 和 [cli/src/runtime/native-worker-client.ts:143](/Users/lqy-macmini/Desktop/vibecoding/Ola/cli/src/runtime/native-worker-client.ts:143) 在 `/tmp` 创建随机 socket；[sidecars/Ola.Native.Worker/Runtime/LocalIpcWorkerServer.cs:37](/Users/lqy-macmini/Desktop/vibecoding/Ola/sidecars/Ola.Native.Worker/Runtime/LocalIpcWorkerServer.cs:37) 未显式使用 Windows CurrentUserOnly，Unix 也未在此处设定私有目录与认证握手。随机名称减少猜测，但不是身份认证；具体跨用户可达性受平台与 umask 影响，本次未做跨用户攻击，归为需补强设计而非已证实远程漏洞。

建议 Unix 使用 0700 私有 runtime 目录和 0600 socket，Windows 使用当前用户 ACL；父子进程认证使用独立受保护通道。限制握手时间、请求体和待处理队列。当前帧上限达 256 MiB，队列创建发生在并发信号量获取之前，应补充累计内存/排队上限，避免“并发数受限但积压不受限”。

### 4.5 远程控制与频道身份管理

远程服务建议补齐 MFA/Passkey、找回账户、密码变更后会话撤销、设备吊销、异地登录告警和可导出审计。现有密码+限流基础不等于完整账户安全生命周期；本次没有测试线上反向代理 TLS、数据库网络暴露或生产密钥强度。

频道增加允许发送者/允许群组、管理员命令名单、敏感文件外发授权、按频道额度与频率限制。将群消息、网页、附件视为不可信输入，而不是把所有接收到的文字都提升为桌面用户授权。

### 4.6 发布与验证治理

现有 AGENTS.md 仍写“没有测试套件”，但仓库已经包含 Go 测试、CodeGraph xUnit 和多项 verify 脚本，文档应更新。很多授权 verify 是正则检查源码形状，适合防止误删校验，不足以证明行为安全。

增加真实 Electron 集成测试、Worker 负向权限测试、协议模糊测试和资源耗尽测试。CI 加入 npm 审计、Go 漏洞扫描、NuGet 审计、秘密扫描和依赖来源核验。GitHub Actions 默认令牌改为只读，仅发布 job 开启写权限；第三方 action 固定审核过的 commit SHA。

仓库同时存在 npm/pnpm/bun 锁文件，当前已要求 npm；建议明确哪些锁文件属于有效构建输入，清除失效来源造成的升级遗漏。给开发者/外部用户提供 SECURITY.md、私密披露渠道、受支持版本和补丁响应时限。

## 5. 分阶段优化实施计划

以下工期是供排期的工程估算，需要按团队人数和平台验证成本调整；不是本次已实施内容。

| 阶段        | 建议投入          | 可交付结果                                                                             | 验收/发布条件                                                      |
| ----------- | ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A：止血     | 2–4 工程日        | 修复 HTML/DOCX 隔离；暂停不可信 JS 扩展或明确可信执行；同步排除秘密；频道越界默认拒绝  | F01–F04/F08 的最小负向用例能阻止攻击路径                           |
| B：边界收敛 | 1–2 工程周        | Main→Worker 可信策略；真实路径校验；SSH/RDP 信任存储；SecretRef 迁移；Shell 重定向策略 | 全局自动批准不覆盖 deny；跨目录/跨频道无法复用授权；主机变更被拒绝 |
| C：系统隔离 | 2–4 工程周        | 扩展独立受限进程；Shell OS sandbox；IPC 收敛；E2EE 同步和资源配额                      | 越权请求被执行端拒绝，恶意任务被终止且主进程正常                   |
| D：持续治理 | 持续，首轮 1–2 周 | 依赖更新、跨平台安全回归、CI 扫描、审计日志、账户功能与事件响应                        | 每个 high/critical 有关闭证据或到期例外；发布附安全验证记录        |

推荐实施拆分：PR-1 预览安全；PR-2 扩展执行隔离；PR-3 频道策略传播及执行；PR-4 路径授权；PR-5 凭据统一与同步迁移；PR-6 SSH/RDP 身份；PR-7 依赖升级；PR-8 CI/回归体系。每个 PR 携带攻击前提、失败用例、修复后的拒绝证据和兼容性结果，避免在一个大改动中混合全部边界。

## 6. 安全回归矩阵

| 场景                                       | 期望结果                         |
| ------------------------------------------ | -------------------------------- |
| HTML 尝试访问 parent DOM/IPC               | 拒绝；不产生系统侧效果           |
| DOCX 包含可执行链接/事件/SVG               | 净化或隔离；点击不执行主界面代码 |
| 扩展访问宿主对象/直连网络                  | 拒绝；资源耗尽能终止执行进程     |
| 频道关闭 home 读取，模型请求外部 Read      | Worker 硬拒绝，自动批准无效      |
| 子 Agent/MCP/SSH/cron 代替频道执行越界操作 | 相同或更窄权限，不借道绕过       |
| 工作目录 symlink/junction 指向外部         | 在写入前拒绝或单独授权真实目标   |
| Shell 只读白名单附带重定向                 | 不自动批准外部写入               |
| SSH/RDP 主机密钥/证书更换                  | 提交认证前阻断                   |
| Linux basic_text/密钥环暂不可用            | 不弱加密落盘、不损坏旧 vault     |
| 同步包含假密钥/被篡改/异常压缩率           | 秘密不可见，非法包不回写         |
| IPC 跨 frame/跨窗口/伪造 runId/参数变化    | 拒绝；审批不可复用               |
| 文件解析巨量内容/协议超长队列              | 有限内存/时间，不阻塞主界面      |

## 7. 本次实际验证与限制

- 已运行 13 项安全 verify：MCP IPC、webview、agent owner、terminal owner、credential injection、desktop IPC、filesystem/shell IPC、API/OAuth IPC、credential/SSH/remote IPC、permission policy、release gates、remote authorization、remote credential lease，全部通过。原始结果保存在本目录。
- `go test ./...` 通过：auth、httpapi、signaling、state；其余列出的包无测试文件。未测试真实 Postgres/Redis/TURN 部署。
- 根 npm 全量/生产依赖在线审计完成；CLI 镜像源首次不支持审计，切换显式官方 registry 的只读审计后得到零告警。没有安装或更新依赖。
- Native Worker 的 `dotnet list ... package --vulnerable --include-transitive --no-restore --format json` 成功返回，未报告漏洞；它仅覆盖该项目当前本地解析依赖，不代表全部 .NET 项目或原生二进制均已审计。`govulncheck` 未安装，未进行 Go 漏洞库扫描。
- [reproduce-boundaries.cjs](/Users/lqy-macmini/Desktop/vibecoding/Ola/security-review/2026-09-14/reproduce-boundaries.cjs) 直接提取当前 JS 沙箱/网络匹配函数，执行真实 TS 权限函数，并验证临时符号链接模型；四组探针均确认报告所述行为。它是审查复现资料，不是修复后应继续返回“存在漏洞”的正式测试。
- DOCX 样本确认当前 Mammoth 保留 `javascript:void(0)`。HTML Chrome 独立验证 25 秒超时，未认定运行态验证成功。
- 未跑完整 Electron UI、生产 RDP/SSH 中间人场景、Windows/Linux 权限矩阵、所有 xUnit 测试、线上扫描、全 Git 历史秘密扫描或所有资源/技能脚本动态执行。没有为只新增报告运行全仓库格式化或业务编译。
- 没有读取 `~/.ola`、真实凭据库、浏览器会话或用户秘密；扫描 npm 时仅进行正常依赖审计请求。报告无真实密钥。

本次结果足以支持优先整改上述确认链路；不能据此签发“项目没有其他安全问题”的结论。整改完成后应以相同基线测试向量，加上打包应用和跨平台实测关闭问题。

复现入口：在已安装依赖的项目环境中运行以下命令（仅探测对象类型、匹配规则和临时路径，不访问真实秘密）：

```bash
node /Users/lqy-macmini/Desktop/vibecoding/Ola/security-review/2026-09-14/reproduce-boundaries.cjs
```
