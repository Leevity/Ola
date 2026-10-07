# 服务商认证数据加密迁移：阶段证据与开放风险

日期：2026-10-04。范围：P3、P10，Main 进程配置读写、服务商 API Key、OAuth 账户令牌及频道认证数据。所有运行验证使用带标记的隔离 E2E 目录、`example.invalid` 邮箱及假令牌，未读取或修改用户真实 `~/.ola` 数据。

原实现由 Renderer 的 `configStorage` 把 `ola-providers` 原样写入 `config.json`；`syncProviderSecrets` 虽复制顶层 API Key 到 Main 加密存储，却没有删除普通配置文件中的 API Key、顶层 OAuth 令牌和 `oauthAccounts[].oauth`。本轮新增认证数据投影：公开配置仅保留服务商和账户元数据及加密引用标记，认证值存入 Main 持有的加密文件；读取时按服务商和账户 ID 恢复，已删除账户不会被旧加密记录重新注入。旧明文配置在加密存储可用时迁移，先写密钥再原子替换公开配置；配置提交失败时回滚密钥快照。加密能力不可用时拒绝新秘密写入，缺失或无法解密的引用不会生成半完整账户对象。隔离 E2E 密钥文件固定在测试根目录，防止碰触实际用户密钥。

单元验证：`provider-auth-persistence.test.ts`、`provider-config-encryption.test.ts`、`provider-secret-store.test.ts`、`extension-secret-store.test.ts`、`config-settings-ipc.test.ts` 合计 23/23 通过。源码和新 Windows x64 安装版的 `settings-save-failure-electron.test.ts` 各 1/1 通过：导入假 OAuth 账户，确认 `config.json` 仅含账户邮箱而不含假访问令牌，确认加密文件存在，正常退出并重启后核对账户和活动令牌恢复。`npm run build`、定向 ESLint 通过。

本轮 Windows x64 NSIS 安装包 SHA-256：`FE28A2E8F105C08995FFF627C4CC8467A20832BB140F75BD9F8F4760948BF8AE`。安装到 `C:\tmp\ola-release-current-20261004xz`；隔离启动 `passed: true`。733 个解包文件和 5197 个 ASAR 条目未发现旧 Worker/.NET 资产。

**最初未通过的异常退出验收（后续在本机修复）：** 在全新隔离 Electron profile 首次保存认证数据后立即强制终止进程，再启动时加密文件仍在且公开配置仍保留引用，但 `safeStorage.decryptString` 报无法解密。检查时 profile 的 `Local State` 尚未落盘；正常退出后相同数据可以恢复。尝试异步安全存储接口和 `flushStorageData` 未解决，已撤回。当时 P3 因此回退为“实现中”；下文记录了本机 Windows x64 修复及剩余平台验收缺口。

补充异常数据保护验证：将隔离测试目录中的加密文件替换为无效内容后重启，Main 拒绝 Renderer 初始化时提交的空服务商列表，公开配置和加密文件均未被覆盖；服务商设置页显示凭据不可读警告并禁止编辑。`settings-save-failure-electron.test.ts` 源码 Electron E2E 1/1、`provider-config-encryption.test.ts` 6/6、`npm run build` 与定向 ESLint 通过。该验证只证明损坏数据不被进一步覆盖，尚未解决首次强制退出后的密钥持久化问题，P3 状态保持“实现中”。

补充首次异常退出修复：Windows Electron 的实际密钥文件位于 `app.getPath('sessionData')/Local State`；此前仅检查 `userData`，漏掉首次写入后 Chromium 异步落盘的密钥。加密存储现在先完成 `safeStorage.encryptString`，等到 `sessionData/Local State` 含 `os_crypt.encrypted_key` 后才提交密文并返回保存成功；超时则报错且不缓存未持久化的写入。隔离 profile 中，首次导入假 OAuth 账户并在保存完成后立即强制终止进程，重启后令牌恢复，源码 Electron E2E 1/1、Windows x64 解包版 E2E 1/1。正常退出及损坏保险库 E2E 1/1，单元测试 10/10、构建与类型检查通过。上述结果解决了本机 Windows x64 的首次异常退出复现；macOS、Linux 和原生安装版尚未完成同等验收。

Windows x64 暂存发布流程成功产出 `dist-staged-win-x64/ola-1.0.5-setup.exe` 与解包版，安装包 SHA-256 为 `30ED7BC88243CE046A5703C1B328AE7207566B1A65A6007EFA8435C85CD26A26`。原生静默安装触发 Windows UAC 授权窗口；自动化环境不能批准提权，目标安装目录没有生成可执行文件。因此不能把解包版 E2E 记作原生安装验收，P3 与 Windows 发布项仍保持未通过。此前从完整开发目录直接打包的两次尝试分别在 Node 4 GiB、8 GiB 堆上耗尽内存；项目的精简暂存打包流程则成功。

加密文件解密后若 JSON 或条目结构损坏，存储层现在抛错并保留原密文，避免把损坏内容当作空保险库后覆盖。相关五个单元测试文件 26/26 通过，`npm run build`、`npm run typecheck:runtime`、定向 ESLint/Prettier 与 `npm run verify:ts-migration-ledger` 通过；设置页 E2E 中原本未收窄的五处 CDP 返回值已补显式校验。该结构校验后的源码 Electron 立即强制退出 E2E 1/1 通过；安装包在此改动前构建，以上安装包运行证据只覆盖此前的密钥持久化修复。

后续横向审查发现 `safeStorage.encryptString` 还被远程账户状态、待完成 OAuth 状态、Mesh 私钥、浏览器 Cookie 加密导出和旧凭据保险库调用。这些写入现在共用 `sessionData/Local State` 密钥落盘门禁。旧凭据保险库的保存、更新、删除改为异步串行写入；损坏的密文或索引不再被当成空数据覆盖。新增 `safe-storage-key-persistence.test.ts`、`secret-vault-persistence.test.ts`，相关测试分别 2/2、4/4 通过。隔离源码 Electron E2E 中，保存假密码后立即强制终止并重启，更新同一凭据成功，证明旧密文可解密；服务商 OAuth 同场景复跑 1/1 通过。`npm run build`、`npm run typecheck:runtime` 及定向 ESLint 通过。远程账户、Mesh 和浏览器 Cookie 入口尚缺各自的异常退出端到端验收，不能据此宣称 P3 全部完成。

补充三条隔离源码 Electron 异常退出验收：① 本地 `127.0.0.1` 假账户 API 登录并加密保存令牌，立即强制终止后重启，成功带同一令牌读取工作区；② 同一流程中注册设备与 Mesh 节点，重启后再次注册时公钥与退出前一致，证明原 Mesh 私钥可解密；③ 在带标记 E2E 根目录导出空 Cookie 集合的加密归档，立即强制终止后由第二个 Electron 进程使用原 `sessionData` 实际解密，工作区 ID 和 Cookie 数量一致。三条对应的 `settings-save-failure-electron.test.ts` 分支均 1/1 通过；Cookie 验证覆盖密钥与归档可解密性，尚未覆盖非空 Cookie 的内容还原。测试导出路径只在 `OLA_E2E_DATA_ROOT` 经过标记校验时启用，不改变正常系统保存对话框流程。上述证据限本机 Windows x64 源码运行；原生安装、macOS、Linux 和真实主站验收仍未完成，P3 保持“实现中”。

补充待完成 OAuth 授权状态验收：隔离源码 Electron 使用本地假 API 开始授权、加密保存 PKCE 状态，首次写入完成后立即强制终止，重启后携原 state 回调成功取得假账户令牌，`settings-save-failure-electron.test.ts` 对应分支 1/1 通过。隔离环境才返回授权 URL 给测试并跳过外部浏览器启动；正常授权仍由系统浏览器打开。P3 台账所列 9 个测试文件共 28/28 通过；`verify:workspace-models`、`verify:managed-model-bridge` 与修复后的 `verify:workspace-runtime` 均通过。`verify:workspace-runtime` 原脚本缺失，本轮增加实际运行离线工作区、账户缓存、模型存储及目录契约测试的入口；另外两个账户测试夹具补上模拟的 Windows `Local State`。这些证据仍不代替原生安装、跨平台或真实主站联调。

补充非空 Cookie 归档异常退出验收：隔离源码 Electron 的内置浏览器访问本机 `127.0.0.1` 假页面，取得一条 `HttpOnly` 假 Cookie，随后通过受信任 `browser:export-cookies` IPC 导出。测试确认导出数量为 1、归档正文没有 Cookie 明文；立即强制终止程序后，第二个 Electron 进程沿用隔离 `sessionData` 解密，得到相同工作区、Cookie 名称、值与域。`RUN_SETTINGS_SAVE_ELECTRON_E2E=1`、`OLA_E2E_COOKIE_ARCHIVE_CRASH=1` 的 `settings-save-failure-electron.test.ts` 1/1 通过，`npm run typecheck:runtime` 和定向 ESLint 通过。该证据补上此前仅导出空集合的缺口；原生安装版、跨平台和真实主站仍未验收，P3 保持“实现中”。

同轮浏览器工作区隔离修复：复用外部浏览器数据时，原 `getBuiltInBrowserSession(workspaceId)` 对所有工作区返回 Electron 默认会话，使团队空间可能共享个人空间 Cookie。现仅 `local-personal` 允许默认会话；团队空间始终使用自身 `persist:ola-browser-<workspace>` 分区。Renderer 浏览器面板、Main WebContentsView 和旧 webview 附着校验使用同一规则。`browser-session-workspace-isolation.test.ts` 等 4 个测试文件 13/13 通过，`verify:browser-workspace-authorization`、`npm run typecheck`、`npm run build` 和本地个人空间非空 Cookie 归档 Electron 用例通过；团队空间实际页面跨空间 Cookie 行为已在下方 Electron 补验。P3 仍需安装版、跨平台及真实主站验收。

团队浏览器实际页面补验：`pending-session-queue-electron.test.ts` 在已认证的模拟团队空间与本地个人空间之间切换。内置浏览器实际访问同一本机 HTTP 服务：个人空间先收到 `ola-e2e-personal` Cookie，团队空间导出时计数为 0；团队页面请求头不携带个人 Cookie，随后团队空间单独收到 `ola-e2e-team` Cookie。清理团队 Cookie 后团队计数为 0，切回个人空间仍为 1。源码 Electron 完整流程 1/1 通过（约 44 秒），`npm run typecheck:runtime` 与测试文件定向 ESLint 通过。该证据验证本机工作区浏览器分区的实际网络行为，不代替真实主站授权、安装版及跨平台验收，P3 继续“实现中”。
