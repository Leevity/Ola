# 性能基线与 Phase 1 优化实测（2026-11-12）

本备忘记录 Phase 0.1 基线与 Phase 1 的逐项实测数值。所有字节数取自
`node scripts/verify-renderer-bundle-budget.mjs --report`，该脚本读 Rollup 的真实模块图
（`out/bundle-manifest.json`，由 `electron.vite.config.ts` 的 `ola-bundle-manifest` 插件产出），
不做字符串嗅探。

## 测量口径

**首屏成本 = entry chunk + 该窗口 root 的静态闭包。** `main.tsx` 通过 dynamic import
到达三个 root（`App` / `NotifyWindow` / `PetWindow`），更深层的 dynamic import 是真懒加载，
不计入。只量 entry 会把真实成本低估一个数量级。

三个 root 由源码模块路径反查 chunk，并在门禁里断言它们**仍然**经由 dynamic import 到达——
若哪天改回静态 import，门禁直接变红，而不是靠人眼发现。

### 测量工具本身修过的三个缺陷

记录在此，因为后续任何"性能提升"的结论都依赖这把尺子：

1. 静态 import 正则要求 `\sfrom\s`，而压缩产物是 `}from"./x.js"`，导致 5 个 chunk 被数成 2 个。
2. 用 `.length` 统计字节。中文语言包是 UTF-16 多字节，`theme-provider` 被低估 93 万字节。改用 `Buffer.byteLength` / `stat().size`。
3. 用库名字符串判断重依赖：`refractor` 命中 gpt-tokenizer 词表里的 "refractory"，`noVNC`/`RFB` 命中翻译文案。**已彻底放弃字符串嗅探**，改按模块路径 `/node_modules/<pkg>/` 归属。

## 首屏字节数（逐阶段）

| 状态                                                           | App           | PetWindow     | NotifyWindow        |
| -------------------------------------------------------------- | ------------- | ------------- | ------------------- |
| A 未压缩、未优化（原始）                                       | 19,004,967    | 未测          | 未测                |
| B 仅开启压缩                                                   | 12,394,856    | 未测          | 未测                |
| C + mermaid / Prism / RemotePage 懒加载（1.1、1.2、1.4）       | 10,730,113    | 7,179,162     | 518,112             |
| D + Settings/Usage/PetStudio 懒加载 + 语言包懒加载（1.3、1.8） | 6,212,763     | 3,478,070     | 518,145             |
| E + gpt-tokenizer 懒加载（1.9）                                | 4,178,047     | 1,443,313     | **853,647（回退）** |
| F 最终（修正 NotifyWindow 回退）                               | **4,178,329** | **1,443,521** | **518,428**         |

App 首屏相对 A 下降 **78.0%**，相对 B（同等压缩条件）下降 **66.3%**。

**E→F 的回退与修正**：把 `i18nReady` 静态 import 进 `main.tsx` 后，英文语言包进了共享
entry，于是**本来完全不用 i18n 的通知窗口**凭空多付 335 KB。改成在启动门禁内部
`import('./locales')` 后，通知窗口回到 518 KB。这条值得记住：共享 entry 的任何新增静态
依赖，都会向所有窗口收税。

### 关键事实：压缩此前根本没开

`electron-vite@5.0.0` 对 main / preload / renderer **三个 target 都默认 `minify: false`**
（`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:300` main、`:407` preload、`:536` renderer）。
也就是说此前发布的安装包一直在为未压缩源码付解析成本。三个 target 现已显式
`minify: 'esbuild'`。

| 产物                   | 优化前  | 优化后    |
| ---------------------- | ------- | --------- |
| `out/main/index.js`    | ~2.6 MB | 1,164,463 |
| `out/preload/index.js` | ~76 KB  | 46,813    |

压缩安全性是**逐脚本核对**过的，不是假设：`verify-ts-migration-ledger.mjs:220-251` 用的是
否定式字符串断言（字符串字面量在压缩后存活），`runtime-main-dependencies.mjs:6` 的
require/import 正则不依赖空白。

### 最终重依赖归属

App 首屏闭包内只剩 `katex(676,105)`。已移出首屏：`mermaid`、`recharts`、
`react-syntax-highlighter` / `refractor`、`gpt-tokenizer`、`ironrdp-wasm`、`@novnc/novnc`、
`@xterm/xterm`，以及 15 种语言的语言包。

`katex` 按计划**刻意保留**：它的 plugin 常量在流式热路径上，懒加载的代价大于省下的字节。
门禁的默认放行名单里只有它，并写明理由。

## 两处计划外、但收益最大的优化

计划里没有这两项，实测它们占了 C 状态首屏的 52%。

### 1.8 语言包懒加载（省 3.61 MB）

`locales/index.ts` 原先 `import.meta.glob('./*/*.json', { eager: true })`，16 种语言全量进首屏。
改为 i18next `BackendModule` + `partialBundledLanguages: true`，只有 `en`（fallback）常驻。

**正确性缺口与闭合**：仓库里有 13 个文件在 React 之外命令式调用 `i18n.t()`
（`ssh-store`、`translate-store`、`ask-user-tool`、`chat-send-message` 等），其中用到
`chat:` / `layout:` / `login:` 三个命名空间。这些调用**无法 suspend**。因此：

- init 时显式传入 `ns: Object.keys(fallbackResources)`，一次性加载当前语言的**全部 10 个命名空间**；
- 导出 `i18nReady`（init 的 promise），`main.tsx` 的启动门禁 `Promise.all` 等它，
  与 workspace 注册并行，不串行。

所以任何命令式 `i18n.t()` 都不可能读到半加载的语言。

### 1.9 gpt-tokenizer 懒加载（省 1.99 MB）

`format-tokens.ts` 静态 import `encode`，但**只有 `estimateTokens` 一个函数用它**；
整个聊天 UI 为了 `formatTokens`/`calculateCost` 而被迫吞下 2 MB 词表。

`estimateTokens` 移入新的 `lib/token-encoder.ts`，词表走 memoized dynamic import。
`format-tokens.ts` 原样 re-export，**8 个 import 点零改动**。

**预算正确性**：token 预算决策绝不能落在近似值上。逐点核实后，在 9 个 async 入口
`await ensureTokenEncoder()`，所有同步 helper 签名不变、测试零改动：

| 入口                                                                          | 覆盖的预算路径                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `chat-send-message.ts` `sendChatMessage` / `runSimpleChat`                    | `chat-turn-control:870`、`context-usage` 的 debug 估算、memory 摘要预算 |
| `use-chat-actions.ts` `previewContextCompressionAt` / `manualCompressContext` | 手动压缩的 `preTokens`                                                  |
| `dynamic-context.ts` `buildRuntimeReminder` / `buildSelectedFileContext`      | 文件上下文预算、`truncateToTokenBudget`                                 |
| `memory-automation.ts` `runPhase2ForRoot`                                     | `needsSummary` 判定                                                     |
| `use-plugin-auto-reply.ts` `_runPluginAgent`                                  | 插件自动回复的 system prompt                                            |
| `pet-agent.ts` `runPetChat`                                                   | 桌宠 system prompt                                                      |

未加载时的兜底是 **UTF-8 字节数**——cl100k 每个 token 至少消耗 1 字节，所以它只会高估、
不会低估；且预算路径已全部 await，兜底实际只可能出现在显示计数器上。

## 冷启动耗时

`scripts/verify-electron-startup.mjs` 原先只有一个固定 4s settle sleep，无法产出耗时数字。
现在它在 `spawn` 前记时，并在 `Page.enable` 之后**轮询 `#root.firstElementChild`**（100ms 间隔、
最多 60 次），把两个字段写进 JSON 摘要：

- `targetReadyMs`：进程启动 → CDP page target 可用
- `firstPaintMs`：进程启动 → 首个 React commit 落地（不是那 4s sleep）

| 运行 | targetReadyMs | firstPaintMs |
| ---- | ------------- | ------------ |
| 1    | 1082          | 1477         |
| 2    | 556           | 897          |
| 3    | 568           | 810          |

第 1 次含冷磁盘缓存，后两次是同一台机器上的热态。三次都通过启动门禁的既有断言
（renderer 零异常、settings 路由遍历）。**没有换型前的冷启动数字**——加计时之前
这个门禁不产出耗时，所以这里只有"现状基线"，不是前后对比。

## 1.6 Vitest 恢复并行

原 `maxWorkers: 1` 是为 Node 25 并发 WASM 编译器 + SQLite fixture 争内存而设的全局 workaround，
338 个文件里只有少数真的需要它。改为 Vitest 4 `projects` 三分：

- `wasm`：7 个 codegraph 文件，单 worker，保留 `--wasm-num-compilation-tasks=1 --no-wasm-async-compilation`
- `serial`：7 个 `*-electron.test.ts`（真的启动 Electron 实例）+ 4 个 spawn 构建的套件，单 worker
- `default`：其余 313 个文件，`maxWorkers: 4`

|          | 基线                                                         | 优化后                       |
| -------- | ------------------------------------------------------------ | ---------------------------- |
| 三次墙钟 | 61s / 61s / 58s                                              | **22.17s / 21.93s / 21.87s** |
| 结果     | 331 passed \| 7 skipped 文件；1630 passed \| 10 skipped 用例 | **完全一致，三次零 flake**   |

约 **2.77×**。没有出现 OOM，未触发回退到 `maxWorkers: 2` 的预案。

### 2026-11-13 峰值内存补测

在 macOS arm64、Node 24.21.0 上以 `/usr/bin/time -l npm run test:runtime` 运行当前套件：

```text
Test Files 338 passed | 7 skipped (345)
Tests      1700 passed | 10 skipped (1710)
Duration   24.38s (wall 24.70s)
Maximum resident set size: 5,176,918,016 bytes (~4.82 GiB)
Peak memory footprint: 26,610,760 bytes (as reported by macOS time)
Swaps: 0
```

`maximum resident set size` 是主要进程树 RSS 观测值；macOS `time -l` 的 peak memory
footprint 是不同口径，保留原始数值，不把两者混为一项。此前三次墙钟仍是 **22.17s /
21.93s / 21.87s**，本次单独补测不替代那组三次稳定性数据。

## 1.5 死依赖清理

全仓扫描（排除 node_modules/out/历史审计 JSON）确认零引用后删除：
`markstream-react`、`rehype-highlight`、`ast-types`、`archiver`、`@types/archiver`、
`@electron-toolkit/preload`、`https-proxy-agent`（直接依赖）。
`@types/react-syntax-highlighter` 移入 devDependencies。`react-is` 保留（recharts 需要）。

`npm install` 实测 **removed 80 packages**。`https-proxy-agent` 仍作为 axios / builder-util
的传递依赖存在——只摘掉了直接依赖，符合预期。

`main.css` 删除 137 行死代码：`@import 'markstream-react/index.css'`、全部 `.ola-markstream`
规则、以及仅被这些规则引用的三个 `@keyframes`（`ai-live-typewriter-node` / `-delta-a` / `-delta-b`）。
删除前逐行断言了边界内容，删除后全仓 `markstream|typewriter-node|typewriter-delta` 命中数为 0。

`electron-builder.yml` 同步移除 `rehype-highlight` 与 `ast-types` 两条已无意义的排除。

### 生产依赖审计面：24 → 20（2026-11-13 补测）

计划给 1.5 的通过标准是"`npm audit --omit=dev` 审计面缩小"，但当时**没有留下数字**，
所以这条标准此前是无证据的。补测方法与结果：

基线取 `git show HEAD:package.json` + `HEAD:package-lock.json`（本轮所有依赖改动之前），
放进临时目录跑 `npm audit --omit=dev --package-lock-only --json`，与当前工作树对比。

| | low | moderate | high | critical | 合计 |
| --- | --- | --- | --- | --- | --- |
| HEAD（本轮之前） | 6 | 12 | 5 | 1 | **24** |
| 当前工作树 | 5 | 9 | 5 | 1 | **20** |

- **消失的 4 个**：`archiver`、`archiver-utils`、`zip-stream`（1.5 删的死依赖）、
  `monaco-editor`（4.3 移除）。全部是本轮主动删除的包，不是 advisory 数据库变动造成的。
- **新增 0 个**。
- `@jitsi/robotjs` 在**两侧 advisory 集合里都不存在**，其依赖只有
  `node-addon-api` / `node-gyp-build`，均不在 20 条里 → 5.0 的 `^0.6.21`→`^0.6.24`
  升级**没有改变审计面**（与上游 diff 只动 CI/manifest 的结论一致）。

**测量口径上的一个坑（必须记录）**：临时目录在仓库之外，`npm` 会退回用户级
`~/.npmrc` 的 `registry=https://registry.npmmirror.com`，该镜像**未实现 audit 端点**，
直接 `404 [NOT_IMPLEMENTED] /-/npm/v1/security/*`，拿不到任何数据。
仓库自己的 `.npmrc:3` 才是 `registry=https://registry.npmjs.org/`。
把仓库 `.npmrc` 一并复制进临时目录后，两次测量才落在**同一个真实端点**上，数字可比。
未修改用户全局配置。

**剩下 20 条都是既有问题，本轮没有修**（超出计划范围）：其中 `dompurify` 为 critical、
`electron` / `vite` / `body-parser` / `follow-redirects` / `zod` 为 high。
`dompurify` 与 `katex` 经 `mermaid` 传递进生产依赖面——1.1 把 mermaid 改成块级懒加载
**只推迟加载时机，不缩小审计面**，不要把它读成安全收益。

## 1.7 预算门禁与反向验证

`scripts/verify-renderer-bundle-budget.mjs`，上限取自本文实测 + 余量：
4,600,000 字节 / 16 chunks（实测 4,178,329 / 6）。

**挂载位置偏离了计划**：计划写的是挂进 `verify:ci-core`，但 CI 的 `quality` job
**从不执行 `npm run build`**（只跑 `runtime:build`），而本门禁依赖构建产物的模块图。
因此挂进 `desktop-smoke` job 的 `npm run build` 之后，与 `verify:legacy-artifacts` 并列。

**反向验证**：见下方"反向验证结果"。

## 反向验证结果

| 检查                  | 做法                                                              | 结果                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预算门禁不是装饰      | 临时给 `mermaid-theme.ts` 加回 `import 'mermaid'`，重新构建       | **变红**：`mermaid contributes 811336 bytes to the first-paint closure of assets/App-skRAy5Ka.js`。移除后重新构建即变绿，且 chunk hash 回到 `App-C0ru3KVI.js`，证明恢复干净 |
| root 必须保持 dynamic | 门禁内置断言：三个 root chunk 必须在 entry 的 `dynamicImports` 里 | 已内置                                                                                                                                                                      |

## 流式 Profiler 实测（2026-11-13 补采）

此前记为「未采集」，阻塞原因是 `lib/streaming-perf.ts:38` 的 `enabled` 硬绑
`import.meta.env.DEV`，生产构建里监控根本不安装。补采办法不是改源码或改门禁，而是
**让已构建的 Main bundle 加载 Vite dev server 的渲染器**：`src/main/index.ts:806` 的
`buildRendererUrl` 条件是 `is.dev && ELECTRON_RENDERER_URL`，而 `is.dev` 取自
`!app.isPackaged`，源码态 spawn 时即为 true，`out/main/index.js` 里也保留了该分支。

探针：`docs/qa/2026-11-13-streaming-profiler-probe.mjs`（只读，不改任何源码/门禁/配置）。
它复用仓库真实的 renderer 配置起 dev server（`localhost:5173`，即 `electron.vite.config.ts:75`
的端口），用隔离数据根 + 本地 OpenAI 兼容 fixture 流式输出一篇长回答，再经 CDP 读
`window.__olaStreamingPerf.snapshot()`。

| 项 | 值 |
| --- | --- |
| 监控是否安装 | **true**（否则下面全是假零） |
| 回答体积 / SSE 分片 | 6,867 字节 / 90 片（10ms 间隔） |
| 流式墙钟 | 3,489ms |
| fixture 收到的模型请求数 | 4 |
| `reactCommit` 次数 | **53** |
| `reactCommit` p50 / p95 / max | **0.1ms / 10.9ms / 46.4ms** |
| `reactCommit` 累计 | 123.3ms |
| `rafGap` 次数 / p95 / max | 246 / 17.7ms / 100.1ms |
| `longTask` 次数 / max | 1 / 103ms |
| `foregroundFlush` / `renderPool` | 2 次 max 0.3ms / 10 次 max 0.2ms |
| `toolArgs` | **0 次（未测到）** |

证据：`docs/qa/assets/streaming-profiler-2026-11-13.json`。

探针文件本身落在 `docs/qa/`，**在 Biome 覆盖范围之外**（`biome format`/`lint` 对该路径
返回 "These paths were provided but ignored"），与既有 `2026-11-12-*-probe.mjs` 一致，
因此它不受格式门禁约束。运行后已确认无残留：调试端口无进程、5173 无监听、临时数据根已删。

**监控自身的预算判定如实照录（没有美化）**：`failures` 非空，两条——
`longTask max 103.0ms > 50ms`、`rafGap max 100.1ms > 80ms`。
因此**不能**据此声称「流式性能达标」。

### 这些数字的口径限制（重要）

1. **这是开发态测量，不是生产性能。** React 开发构建 + Vite 未压缩逐模块服务，
   两者都显著慢于生产。上面的 max/p95 不能当作生产体验的指标，也不能与生产数值混比。
2. **dev 态 Profiler 无法有效度量本轮的懒加载优化。** 开发态没有打包，
   懒加载与静态 import 的差别在生产态才体现为「首屏少解析多少字节」。
   所以拿 dev 态做 1.1/1.2 的前后对比只会测到噪声。
   生产侧的有效前后证据是 bundle 门禁：首屏闭包 4,178,329 字节基线，
   且 mermaid/recharts/ironrdp/prism/monaco 均不在首屏闭包内（见 1.7 反向验证）。
3. **只跑了一次**，没有多次采样，不是稳定基准。
4. `modelRequests: 4` 说明 fixture 收到了 4 次请求（含会话标题一类的辅助调用），
   53 次 commit 覆盖的是「发送→回答渲染完成」整个窗口，不是纯回答流。
5. `toolArgs` 为 0：探针回答不含工具调用，该桶**未被测量**。
6. 监控在 HEAD 就已存在（`streaming-perf.ts` 本轮未改），所以「前后对比」在构造上可行，
   但受第 2 条限制，本轮**没有**做 dev 态前后对比，不把它列为已交付证据。

## 尚未覆盖

诚实记录，避免把"部分完成"读成"通过"：

- **流式渲染 Profiler 数据已于 2026-11-13 补采**，见下节「流式 Profiler 实测」。
  仍缺的是**生产态**流式对比：监控硬绑 `import.meta.env.DEV`，生产构建里根本不安装，
  因此本轮的流式数字只能代表开发态，不能与生产体验划等号。
- `verify:packaged-startup` 已于 2026-11-13 对本机 macOS arm64 runtime-staging `.app` 尝试，
  但 60 秒未发现 renderer 页面而失败；主线程采样停在未识别的 `NSAlert.runModal`。
  因而 `IronRdpViewer.tsx:14` 的 `?url` WASM 导入在 `file://` 打包态下仍**未验证**。
  详见 [utilityProcess QA 的打包态复验](2026-11-12-utilityprocess-isolation.md#打包态启动复验2026-11-13未通过)。
- 语言包懒加载与 tokenizer 懒加载**未在真实 UI 中手工冒烟**：切换语言、
  首次输入时的 token 计数、手动上下文压缩，都还没有像素级或交互级证据。
- 六平台未验证。
