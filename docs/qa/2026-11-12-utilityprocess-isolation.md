# Phase 7：Agent runtime 迁 Electron utilityProcess（2026-11-12）

**状态：7.1 / 7.2 / 7.3 已完成并有实测证据；7.4 门禁与台账已收口。未提交（遵循「全程不自动提交」）。**

本备忘记录实测数值、反向验证结果、以及**未覆盖的部分**。

---

## 结论先说

Agent 运行时在 Electron 内已改为独立子进程，崩溃只损失运行而不拖垮窗口。
迁移的本质不是新建传输，而是**把注入方向反转**：socket / named pipe、长度前缀 JSON 帧、
`hello` 握手原本就存在，改的是「谁向谁发起请求」。

三条安全边界原样保留，且各有反向验证：

- **供应商 Key 只在 Main 解析**，跨 socket 的只有语义化 `ModelDelta`、工具目录与批处理结果。
- **hooks 留在 Main**（`tool-hook-lifecycle.ts` 的边界未动），经反向 RPC 触发。
- **审批策略留在 Main**，子进程只能请求交互，不能自行放行。

---

## 计划前提的核实与纠正

| 计划原说法 | 核实结果 |
| --- | --- |
| 「`verify:ts-runtime-production` 是对 10 个具名文件的字符串 allowlist，不含 utilityProcess」 | 属实。逐条核对 `scripts/verify-ts-runtime-production.mjs:31-107`，禁的是 `OLA_ENABLE_LEGACY_NATIVE_WORKERS`、`registerSidecarHandlers`、`from './lib/native-worker'`、`streamSidecarProviderTurn` 等具体标识符，新代码一个都不触发 |
| 「真正的阻塞是约 250 行注入闭包」 | 属实，但**闭包本身一行未改**。外提的是「谁来调用它」：`desktop-runtime.ts` 的 `authorize` / `adapter` / `tools` / `workspaceIds` 原样交给 `createRuntimeHostBridge`，由它代替子进程执行 |
| 「新增反向请求 `tool.execute`、`authorize`、`provider.resolve`、`interaction.request`、`workspace.authority`」 | `provider.resolve` **不可实现**：`ModelTransport.request` 返回 WHATWG `Response`（流式 body），无法序列化。代理接缝改为 `ProviderAdapter.stream`，跨 socket 的是 `ModelDelta`。`interaction.request` 归入 `host.run.interaction`，由 Main 侧 `ToolContext` 发起 |
| 「journal 在 SQLite worker 中持久化，但 scheduler 在内存——重启后需重放或明确标记中断」 | `journal.recover()` **已经**把非终态运行标记为 `interrupted` + `RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS`，并中断挂起交互（`journal-worker.mjs:310`）。无需新代码，崩溃测试直接断言该行为 |

---

## 协议与传输

- `RUNTIME_PROTOCOL_VERSION` 1 → **2**，新增 `MIN_RUNTIME_PROTOCOL_VERSION = 1` 保留协商窗口。
- 连接描述符文件格式版本独立为 `RUNTIME_CONNECTION_DESCRIPTOR_VERSION = 1`。
  这是 7.1 最后一个失败测试暴露的真实混淆：`desktop-runtime.test.ts` 原先把磁盘文件格式版本
  当成 wire 协议版本断言，两者必须分开。
- 新增 `host` capability。**v1 对端永不获得 host 权限**；进程内宿主（测试与 CLI）
  构造 `RuntimeServer` 时不传 `allowHost`，因此同样不授予。
- 帧上限：公开仍是 `MAX_RUNTIME_FRAME_BYTES = 1 MiB`；**仅在对端证明自己是 host 之后**
  才放宽到 `MAX_HOST_FRAME_BYTES = 8 MiB`（`FrameDecoder.allowHostFrames()`）。
  未认证 socket 无法让服务分配这块内存。
- 模型上下文按增量发送：首轮 `reset: true` 带完整 `RunSpec`，后续只发 Agent 新追加的消息。
  长会话每轮重发全量历史是纯浪费。

### 两个必须绕开的传输陷阱

1. **`RuntimeServer` 按 socket 串行化请求**（`tail = tail.then(...)`）。
   host 的**应答**若排队，会排在正在等它的那个 dispatch 后面 → 双向死锁。
   host 的**请求**若排队，审批与嵌套运行会互相饿死。两者都走旁路。
2. **host 请求并发上限 64**，应答带外发送；`timeout = 0` 表示无期限（人工审批），
   只有取消或失去运行时才结束。

---

## 实测数值

| 项 | 数值 |
| --- | --- |
| `out/runtime/isolated.mjs` | **74,799 字节** |
| `out/runtime/cli.mjs`（对照） | 229,173 字节 |
| 新增测试 | `runtime-host-callbacks` 10 例、`isolated-runtime-host` 9 例、`isolated-runtime-crash` 3 例 |
| 全量套件（Phase 7 前） | 335 文件 / 1684 例 / 20.33s |
| 全量套件（Phase 7 后） | **337 文件 / 1696 例 / 29.54s** |
| `format:check` | 1870 文件，0 错误 |
| `lint:ci` | 128 warnings（既有 `useExhaustiveDependencies`，退出码 0） |
| `verify:ci-core` | 退出码 **0**（77 个门禁全链） |
| `verify:ts-migration-ledger` | **376/376** route/language 条目通过 |

子进程 bundle 比 CLI 小约 2/3，因为供应商协议栈与桌面工具都不再进子进程。

崩溃测试的 9.1s 是**真实 SIGKILL + 退避重启**的墙钟，不是 mock 延时：
放弃阈值那例要跑满 250+500+1000+2000+4000ms 退避，故放入 `serial` project。

---

## 反向验证（每条都实际跑红过）

| 被破坏的语义 | 结果 |
| --- | --- |
| 去掉 host 应答的队列旁路 | `serves a callback from inside a dispatch without deadlocking` 超时变红（7.1） |
| 注释掉监管器的 `void restart()` | `restarts after a crash…` 变红：`expected +0 to be 1`（restarted 计数） |
| 在 wire spec 的 `modelSource` 注入 `apiKey: 'leaked'` | `completes a model/tool/model loop with tools and credentials owned by Main` 变红：`+ "apiKey"` |
| 给 v1 对端授予 host | `never hands host authority to a version 1 observer` 变红（7.1） |
| 允许第二个 host 连接 | `rejects a second host so credential authority has exactly one owner` 变红（7.1） |

凭据那条不是装饰性断言：它锁住 `modelSource` 的键集合，
任何人日后想「顺手把 key 传给子进程省一层代理」都会立刻撞红。

---

## 崩溃恢复的实测行为

`tests/runtime/isolated-runtime-crash.test.ts` 用真实子进程（`tests/fixtures/isolated-runtime-child.mjs`
把 Node fork 的 `process.send` 适配成 utilityProcess 的 `parentPort`，生产入口不带第二套传输）：

1. 提交一个模型流永不结束的运行，确认进入 `running`。
2. `SIGKILL` 子进程。
3. 断言：`onDisconnected` 触发一次（Main 侧 run 状态全清）、监管器重启并重新握手、
   `ping` 返回 v2、该运行变为 **`interrupted`**，终态事件 reason 为
   `RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS`，且**只起了 2 个进程**（不重放副作用）。
4. 另一例让每个替换进程一报 ready 就死，断言连续失败超过 5 次后上报
   `RUNTIME_UNAVAILABLE` 并停止重启（≥6 个进程）。

### 过程中修掉的一个真实缺陷

监管器原先在 `ready` 时把 `failures` 归零。这意味着「启动成功但立刻崩溃」的子进程
会**永远重启**，放弃阈值形同虚设。改为只有存活满 `STABLE_AFTER_MS = 30_000` 才清零失败计数。
上面第 4 例就是这个修复的证据。

另外补了一处取消语义：Main 中止模型流时会关闭 stream，子进程的 `DeltaBuffer` 正常结束，
Agent 循环原本会把这一轮当成「完成」。`host-proxies.ts` 在流结束后补 `throwIfAborted()`，
被取消的轮次不再发出假的 `message.completed`。

---

## 打包与产物

- `scripts/build-ts-runtime.mjs` 新增 `src/runtime/host/isolated.ts` → `out/runtime/isolated.mjs`
  的 esbuild 入口（与 CLI 同参数：`platform: node`、`format: esm`、`target: node24`、`external: ['ws']`）。
- 子进程复用既有 worker 布局：`./journal-worker.mjs` 与 `../storage/lease-worker.mjs`，
  **没有新增第二套资产目录**。
- `electron-builder.yml` 的 `asarUnpack` 新增 `out/runtime/isolated.mjs`、
  `out/runtime/journal-worker.mjs`、`out/runtime/journal-schema.mjs`。
  Node Worker 无法从 asar 内加载，三者必须一起解包。
- `scripts/verify-runtime-main-assets.mjs` 现在硬断言这三个产物存在**且**都在 asarUnpack 里。
- socket 每次启动都在新的 `mkdtemp('/tmp/ola-runtime-')` 里，服务锁是 SQLite 的 OS 写锁，
  进程死亡自动释放——所以 SIGKILL 后重启不会撞 EADDRINUSE 或 `RUNTIME_DATA_LOCKED`。

---

## 打包态验证脚本的跨平台缺陷（2026-11-13 收尾时发现并修复）

`scripts/verify-packaged-electron-process-startup.mjs:26` 原文：

```js
const mainBundle = asar.extractFile(archivePath, 'out\\main\\index.js').toString()
```

asar 条目路径被**硬编码成 Windows 反斜杠**。`@electron/asar/lib/filesystem.js:60` 的实现是
`const dirs = p.split(path.sep)` —— 它按**宿主平台**的分隔符拆路径，而归档头里的键是
`out` / `main` / `index.js` 逐层嵌套。因此在 POSIX 上 `out\main\index.js` 是一个不含分隔符的
单段文件名，查不到节点。

**最小 asar 决定性实验**（不需要完整打包，`/tmp/asar-probe`）：

```
path.sep = "/"
entries: [ '/out/main/index.js' ]
OK   "out/main/index.js"   -> export const marker = "OLA_E2E_DATA_ROOT"
FAIL "out\main\index.js"   -> "out\main\index.js" was not found in this archive
```

即：**该脚本在 macOS/Linux 打包态必然抛错，根本走不到启动检查**。
`docs/migrations/ts-runtime/evidence/` 下所有引用它的证据文件都是 `windows-x64-*`，
与「只在 Windows 上跑过」一致 —— 这不是本轮引入的回归，是既有平台盲区。
它恰好挡住了本备忘「未覆盖」一节里六平台打包验证的**非 Windows 那一侧**。

**修复**：改用宿主分隔符拼接，两个平台都由构造保证正确：

```js
const mainBundle = asar.extractFile(archivePath, join('out', 'main', 'index.js')).toString()
```

macOS 上 `join()` 产出 `out/main/index.js`，同一最小 asar 实验取文件成功。
Windows 上 `join()` 产出反斜杠形式，与原行为一致，**不削弱既有 Windows 验证**。
`node --check` 通过，`biome format` / `biome lint` 均 exit 0。

顺带核实 `scripts/release-sbom.mjs:24-40` 的 `extractManifest()` **已经**跨平台安全：
它依次尝试 original / normalized / 反斜杠 / 前导斜杠四种拼法并吞掉失败，无需改动。
全仓 `scripts/*.mjs` 中 `extractFile` / `listPackage` 共 7 处，只有上面那一处是硬编码单反斜杠。

### 本地构建解开的 3 个 skipped 门禁

此前全量扫描固定 skip 三个门禁（缺构建产物）。本轮做了一次**临时本地构建**
（`npm run build`，exit 0；产物仅用于验证，不作为交付物保留），三者全部实跑通过：

| 门禁 | 结果 |
| --- | --- |
| `verify:runtime-main-assets` | exit 0 — TS runtime Main worker assets verification passed |
| `verify:ts-runtime-production` | exit 0 — TS runtime production boundary verification passed |
| `verify:settings-typecheck` | exit 0（内含 `tsc --noEmit -p tsconfig.web.json`） |

这意味着 Phase 7.4 要求的 `out/runtime/isolated.mjs` 等产物存在性与 asarUnpack 硬断言、
以及 production 边界 allowlist，**在本轮全部改动之后仍然成立**，不再只是「文本上应该成立」。

### 为什么 macOS 打包态仍不能在本地验收（不是脚本问题，是签名问题）

修好 asar 路径后，非 Windows 侧的**脚本阻塞已解除**，但本机仍无法产出可信的打包态证据：

```
security find-identity -v -p codesigning  →  0 valid identities found
electron-builder.yml  mac: hardenedRuntime: true, notarize: true
build/entitlements.mac.plist:
  com.apple.security.cs.allow-jit
  com.apple.security.cs.disable-library-validation
  com.apple.security.cs.allow-unsigned-executable-memory
  com.apple.security.cs.allow-dyld-environment-variables
```

`disable-library-validation` 与 `allow-unsigned-executable-memory` 正是原生模块加载与
子进程派生在硬化运行时下的关键授权。**未签名 / 未启用硬化运行时的本地包不会复现 CI 签名包的行为**，
用它跑出的「打包态 utilityProcess 正常」不能作为验收证据 —— 那会把一个签名相关的失败模式掩盖掉。

因此本轮**刻意不做**本地未签名打包验证。#34 的剩余部分需要：
CI 产出的签名安装包（需提交/推送，用户未授权）+ 各平台实机。
本轮把该路径上**唯一的代码侧阻塞**（asar 反斜杠）修掉了，并留下最小 asar 复现实验，
使 CI 产物一旦就绪即可直接在 macOS/Linux 上跑该脚本。

### 本轮收尾的其余实测（均在临时本地构建之后）

| 验证 | 结果 |
| --- | --- |
| `npm run build` | exit 0（typecheck + electron-vite + runtime:build） |
| `verify:runtime-main-assets` | exit 0 |
| `verify:ts-runtime-production` | exit 0 |
| `verify:settings-typecheck` | exit 0 |
| `verify:electron-startup` | `passed: true`，`isolatedRuntimePid: 14017`，firstPaint 1302ms |
| `npm run test:runtime` | **338 文件 / 1700 测试通过，0 失败**，7 文件 + 10 测试 skipped，29.59s |
| `npm run verify:renderer-bundle` | exit 0，最差窗口 4,185,121 字节 / 6 chunks；CM6 引擎 422,148、TS worker 6,754,263、monaco 模块 **0** |
| `npm run verify:ts-migration-ledger` | exit 0，**376/376** route/language 条目 accepted，exit mode=false |
| `npm run verify:ci-core` | **exit 0**，77 个脚本全链串行跑完（避免 esbuild 缓存竞态） |

测试墙钟 29.59s 对照 Phase 0.1 基线 60–70s，Phase 1.6 的 vitest projects 并行化收益在本轮全部改动后仍然保持。

首屏字节相对 1.7 记录的 4,178,329 上涨 6,792（Phase 2/3/7 的新增代码），仍远低于 4,600,000 上限，
且 mermaid/recharts/ironrdp/prism/monaco 均不在首屏闭包内。

**脚本名口径**：npm 脚本是 `verify:renderer-bundle`，脚本文件才叫
`scripts/verify-renderer-bundle-budget.mjs`。两者不同名，写备忘与复现命令时不要混用。

**产物处置（如实记录）**：本轮只跑了 `npm run build`，**没有**跑 `electron-builder`，因此没有产生任何
`dist/` 安装包。`out/`（37M）被 `.gitignore:3` 忽略、不会进入提交，且 `verify:renderer-bundle`
与用户本地 `npm run dev` 都依赖它，故**保留在原地未删**，不作为交付物。
需要干净树时 `rm -rf out` 即可完全再生。

---

## 未覆盖的部分（不要当成已验收）

- **真实 Electron `utilityProcess` 路径未被 vitest 覆盖。** vitest 里 `electron` 解析成
  路径字符串，`utilityProcess` 为 undefined，`isolatedRuntimeSupported()` 返回 false，
  所有单元测试走进程内宿主。崩溃测试用 Node fork 适配器验证的是**监管器契约与子进程 bundle**，
  不是 Electron 的 utilityProcess 本身。真实 Electron 路径由 `verify:electron-startup`
  的正向 pid 断言覆盖，**但只在 macOS arm64 源码态实测过**（见下）。
- **六平台打包验证未做**：socket 路径权限、Windows named pipe ACL、asarUnpack 实际解包结果、
  各平台安装包内的崩溃注入，都仍需实机。台账 P12 保持「实现中」。
  **本轮补充：非 Windows 侧此前连验证脚本本身都跑不起来**，见下节「打包态验证脚本的跨平台缺陷」。
- **`process.defaultApp` 在 utilityProcess 子进程中的取值未直接打印**。
  `run-journal.ts:19` 据此选择 worker 路径。源码态实测子进程成功打开 journal 并完成模型往返，
  说明该分支在当前布局下解析正确；**打包态仍未实测**，打包启动验证是那一侧的唯一证据来源。
- **崩溃后孤儿 socket 目录**：SIGKILL 会留下一个 `/tmp/ola-runtime-*` 空目录。
  不影响重启（每次新 mkdtemp），但长期崩溃循环会累积。未做清理，属已知小泄漏。
- **跨重启续跑仍未实现**：运行被标记 `interrupted` 等待人工裁决，不自动恢复。
  这是刻意的副作用安全选择，与 README 既有边界一致。
- 计划列出的 18 个受影响测试文件**无需修改**：它们通过 `DesktopRuntime` 的公开接口断言，
  而进程内路径保持了原有行为。这是「测试与 CLI 不授予 host capability」这一设计的直接收益。

---

## 真实 Electron 启动验证

### 先踩到的两个坑（都已修，并留下门禁）

**坑 1：`verify:electron-startup` 不重新构建。** 它只 `spawn` Electron 跑现有 `out/`
（`scripts/verify-electron-startup.mjs:108`）。Phase 7 改完源码后我直接跑了两次该门禁，
两次都 `passed: true`——但 `grep -c "isolated runtime ready" out/main/index.js` 是 **0**，
也就是说那两次跑的是 Phase 7 之前的旧 bundle，**证据无效**。
先 `npm run build` 再跑，才是有效验证。

**坑 2：子进程入口路径解析错误（真实回归）。** 重新构建后门禁立刻变红：
渲染侧报 `TS_RUNTIME_AGENT_UNAVAILABLE: RUNTIME_UNAVAILABLE`，Main 日志是

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '<root>/out/main/out/runtime/isolated.mjs'
[TsRuntime] desktop host startup failed: RUNTIME_START_FAILED
```

原实现用 `join(app.getAppPath(), 'out/runtime/isolated.mjs')`。但 Electron 有两种启动方式：
`electron .` 时 `getAppPath()` 是仓库根，`electron out/main/index.js` 时是 `out/main`——
门禁和打包态用的是后者，于是拼出了 `out/main/out/runtime/...`。
改为从**本 bundle 自身**解析，与 `run-journal.ts:21`、`service-lease.ts:12` 同一约定：

```ts
return fileURLToPath(new URL('../runtime/isolated.mjs', import.meta.url))
```

打包态分支不变（显式 `app.asar.unpacked`）。`scripts/launch-dev.mjs:21` 会先跑
`build-ts-runtime.mjs`，所以开发态 `out/runtime/isolated.mjs` 一定存在。

### 新增的正向门禁断言

只靠「禁止出现的字符串」列表无法证明隔离真的发生了：子进程没起来时窗口照样打开。
因此 `verify-electron-startup.mjs` 现在**要求**日志里出现
`[TsRuntime] isolated runtime ready (pid <n>)`，并把 pid 写进 JSON 结果。

**反向验证**：把该日志文案临时改成 `isolated runtime prepared (pid`，只重建 main，
门禁变红并给出精确原因：

```
Error: Electron startup never reported an isolated runtime child;
       the utilityProcess path was not exercised
```

改回后重新构建，门禁恢复绿。

### 实测结果（macOS arm64，源码态，隔离数据根）

| 指标 | 旧 bundle（进程内，无效证据） | 新 bundle（utilityProcess） |
|---|---|---|
| `passed` | true | true |
| `isolatedRuntimePid` | 无此字段 | 41725 / 42704 / 14017（三次独立运行） |
| `targetReadyMs` | 539 | 1032 / 718 / 1064 |
| `firstPaintMs` | 752 | 1247 / 1201 / 1302 |
| `translateFlowChecked` | true | true |

第三次运行（2026-11-13 收尾，Phase 0.2 第五组缺陷修复 + asar 路径修复之后）另含
`routeCount: 23`、`featureSurfaceCount: 6`、`accountAuthChecked: true`、`bodyTextLength: 434`。

证据：`docs/migrations/ts-runtime/evidence/electron-startup-2026-11-13.txt:20-21`
同时含 `[TsRuntime] isolated runtime ready (pid …)` 与 `[TsRuntime] desktop host ready`，
截图同目录 `.png`。

## 真实 Electron utilityProcess 崩溃注入（2026-11-13）

新增 `scripts/verify-electron-runtime-crash.mjs`，由 `npm run verify:electron-runtime-crash`
先重建当前 bundle，再启动真实 Electron。探针只使用 `127.0.0.1` 上的本地 OpenAI 兼容 fixture，
Electron 使用带 `.ola-e2e-root` 标记的临时数据根。fixture 保持聊天模型响应未完成；探针确认
对应 run 已进入 journal 且仍为 `running` 后，对日志中 utilityProcess 的 PID 发送 `SIGKILL`。

实测顺序与断言：

1. 最近一次标准命令运行中，第一 utilityProcess PID `27951` 处理聊天 run；Main Electron 窗口仍在运行。
2. Main 关闭旧连接，`RuntimeClient` 对活动订阅发出 `RUNTIME_DISCONNECTED` resync；本次实际
   观察到 **1 条** run stream 收到 resync。
3. Main 以新 PID `27993` 拉起 utilityProcess；`isolated runtime reconnected after journal recovery`
   只在重新 `hello` 握手成功后记录。
4. 新 runtime 打开同一 SQLite journal，并将原 run 记为 `interrupted`；最后一条状态事件原因为
   `RUNTIME_RESTARTED_REVIEW_SIDE_EFFECTS`。fixture 没有收到可完成响应，run 没有被静默遗失，
   也没有重放未审阅副作用。
5. renderer 根节点仍存在，Electron 主窗口未随 utilityProcess 崩溃退出。

结构化结果：`docs/qa/assets/utilityprocess-crash-2026-11-13.json`。该结果只证明本机 macOS
源码态路径；Windows named pipe、Linux/macOS 打包态与各架构的实际安装包崩溃注入仍未覆盖，
所以 P12 保持「实现中」。探针会清理其临时数据根，不读取或修改用户的 `~/.ola`。

**诚实记录代价**：冷启动比进程内宿主慢约 200–500ms（多一次进程启动 + 握手 + SQLite worker 初始化）。
这是崩溃隔离的代价，不是回归缺陷；`translateFlowChecked: true` 证明真实模型往返
（渲染 → Main → 反向 RPC → 子进程 → provider fixture）全程走通。
两次运行数值有波动，未做多次采样统计，不能当作稳定基准。

## 打包态启动复验（2026-11-13，未通过）

为补 Phase 1/4/7 的 asar 打包启动证据，先用 `npm run package:runtime-staging -- --mac --keep`
生成本机 macOS arm64 staging `.app`。打包及 runtime staging 资产校验通过，app 仅为 ad-hoc
签名；本机没有可用 Developer ID，不能把该产物当作签名发布包。

`scripts/verify-packaged-electron-startup.mjs` 启动该 app 后 60 秒未发现 CDP renderer 页面，
因此失败；原串联命令使用 `&&`，`verify-packaged-electron-process-startup.mjs` 没有执行。
主进程没有退出，但 stdout/stderr 为空、无 renderer/utility 子进程。对主进程做 5 秒
`sample`，主线程停在 `-[NSAlert runModal]`。当前无法识别弹窗来源或文字，故没有推断它是
系统提示还是应用提示。Info.plist 的 ElectronAsarIntegrity 值与 ASAR header SHA-256 一致。

第二次复现加上 Chromium `--enable-logging=stderr --v=1` 后，Chromium 只记录了本机显示器，
隔离数据根下仍没有 Main startup/crash log；`lsof` 确认主进程已打开 `app.asar` 与
`node-pty` native addon。通过当前 CUA 获取 app AX tree/screenshot 再次超时，无法读出弹窗。
进程随后已终止。详细复现记录追加在同一 evidence 文件。

完整复现及观测见
[`electron-packaged-startup-2026-11-13T03-45-17-218Z.txt`](../migrations/ts-runtime/evidence/electron-packaged-startup-2026-11-13T03-45-17-218Z.txt)。
**打包态启动验收仍未通过**；需先识别并处理该原生模态框，再运行两个 packaged startup
检查。当前源码态 utilityProcess 崩溃注入通过，不代表打包态验收通过。

---

## 复现命令

```bash
node scripts/build-ts-runtime.mjs
npx vitest run --project default tests/runtime/isolated-runtime-host.test.ts
npx vitest run --project serial tests/runtime/isolated-runtime-crash.test.ts
npm run typecheck && npm run typecheck:runtime
npm run lint:ci && npm run format:check
npm run verify:ci-core
npm run verify:ts-migration-ledger
# 必须先构建：该门禁只 spawn Electron 跑现有 out/，不会重新构建。
npm run build
npm run verify:electron-startup
```
