# Phase 0.2 源码文本门禁去格式化耦合（2026-11-13）

计划要求：新建 `tools/lib/source-text.ts`，把依赖 formatter 空白的门禁逐个迁移，并且
**反向验证不可省** —— 每个迁移后的门禁，临时破坏被断言的源码**语义**（不是格式），确认门禁仍然变红。

本备忘记录实测范围、两处折叠陷阱、反向验证抓到的一个真实安全门禁缺陷及其修复，以及尚未覆盖的部分。

## 结论先说

| 测量 | 结果 |
| --- | --- |
| 迁移前 width-60 扫描 | **27 RED** / 46 green / 3 skipped（共 76） |
| 迁移后 width-60 扫描 | **0 RED** / 73 green / 3 skipped |
| 迁移后真实仓库 width-100 扫描 | **0 RED** / 73 green / 3 skipped |
| 接入 `lib/source-text` 的门禁 | 27 / 27 |
| 断言数减少的门禁 | **0 个**（全部持平或增加） |
| 反向验证抓到的真实缺陷 | **1 个**，已修复并复验 |

计划原文估的是「22 个 tools / 81 条断言」。实测范围更大：**27 个门禁**。差额来自计划未点名的
`verify-remote-workspace-theme`、`verify-ssh-store-modules`、`verify-ssh-reconnect-logs`、
`verify-draw-image-ops`、`verify-task-board` 等，它们在 width-60 下同样变红。

## 测量口径

扫描器 `/tmp/ola-fmt-probe/run-gates.mjs`：解析 `package.json` 的 `verify:ci-core` 链取出全部门禁名，
逐个以 `npm run <gate>` 执行，记录退出码。两个副本：

- `/tmp/ola-fmt-audit`：`biome.json` 的 `lineWidth` 改为 **60**，`src/` 已按该宽度重排版。这是**压力格式**，
  比生产宽度更极端，用来暴露空白耦合。
- 真实仓库：`lineWidth` **100**，即生产格式。

`node_modules` 是指向真实仓库的符号链接，所以副本不重复安装依赖。

**3 个 skipped 是口径的一部分，不是遗漏**：`verify:runtime-main-assets`、`verify:ts-runtime-production`、
`verify:settings-typecheck` 需要真实构建产物或活体 Electron。构建产物已按用户要求删除（后续由 GitHub CI 构建），
所以它们在本地必然失败，且失败与格式化无关。把它们计入 RED 会污染测量。

`verify:ci-core` 之外还有 16 个 `verify:*` 脚本，其中 7 个读文件。逐一核对后只有
`verify:ts-migration-ledger` 是纯文本门禁（其余是 staging / 活体 Electron / 构建产物检查）。
它在 width-60 下单独跑过：**exit 0，376/376 route/language entries accepted**。

## 两处折叠陷阱（都是实测撞出来的，不是推理）

`collapseWhitespace` 把 `\s+` 换成一个空格，**绝不丢弃 token**，所以计数与顺序断言语义不变。
但「不丢 token」不等于「模式不用改」：

1. **折行数组会多出一个空格。** Biome 在窄宽度下把
   `export const MOTION_LEVELS = ['full', 'reduced', 'off'] as const`
   排成每元素一行，折叠后变成 `[ 'full', 'reduced', 'off' ]` —— `[` 后面**有一个空格**。
   所以 `\['full'` 仍然失败。凡是 `[` `{` `(` 之后、`]` `}` `)` 之前、`:` `,` 之后、
   三元 `?` `:` 两侧，都要写 `\s*`。
2. **CSS 的 `var()` 会被拆开。** 窄宽度下 Biome 输出 `var( --ola-motion-feedback )`，
   于是 `var\(--ola-motion-feedback\) !important` 失败。必须写成
   `var\(\s*--ola-motion-feedback\s*\)\s*!important`。

第一条陷阱让 `verify-motion-levels` 的第一版修复在 width-60 下仍然红；补齐后 width-100 与 width-60 双绿。
这两条已作为配方传给所有并行修复任务。

另有两条边界规则写进了 `tools/lib/source-text.ts` 的注释：

- **折行成员链**变成 `a .b .c`，字面量 needle 会失败 → 用 RegExp 在点号两侧加 `\s*`（`assertOrder` 已注明）。
- **行锚定模式**（`m` flag、`^`/`$`、逐行扫描）必须留在 `readSource()` + `assertRawMatch`。
  `assertMatch` 会主动拒绝带 `m` flag 的模式，防止有人误用。

## 断言数逐门禁核对（HEAD → 现在）

计数正则必须覆盖 lib helper：`assert[A-Za-z]*(\.[A-Za-z]+)?\(`。
只用 `assert(\.[A-Za-z]+)?\(` 会漏掉 `assertIncludes(` / `assertMatch(`，
把「改用 helper」误报成「断言减少」—— 第一版核对就踩了这个坑，`verify-chat-experience` 一度显示 43→8，
实际是 43→65（文件从 288 行增长到 376 行）。

| 门禁 | HEAD | 现在 | 否定断言 HEAD→现在 | throw 守卫 HEAD→现在 |
| --- | --- | --- | --- | --- |
| verify-chat-experience | 43 | 65 | 2→2 | 1→1 |
| verify-browser-cookie-import | 19 | 19 | 2→2 | 1→1 |
| verify-browser-workspace-authorization | 0 | 0 | 0→0 | 4→5 |
| verify-ai-coding-terminal | 15 | 15 | 4→4 | 0→0 |
| verify-codegraph-dashboard | 24 | 24 | 2→2 | 0→0 |
| verify-remote-authorization | 27 | 82 | 0→0 | 0→1 |
| verify-mcp-ipc-authorization | 8 | 8 | 0→0 | 0→1 |
| verify-mcp-oauth | 70 | 70 | 4→4 | 1→1 |
| verify-channel-lazy-providers | 10 | 10 | 1→1 | 0→0 |
| verify-cron-skipped-runs | 20 | 21 | 0→0 | 0→0 |
| verify-message-locator | 15 | 15 | 0→0 | 0→0 |
| verify-webview-security | 26 | 26 | 0→0 | 0→0 |
| verify-terminal-owner-isolation | 21 | 24 | 0→0 | 0→2 |
| verify-credential-injection-authorization | 14 | 15 | 0→0 | 0→0 |
| verify-desktop-ipc-authorization | 14 | 14 | 0→0 | 0→1 |
| verify-network-download-safety | 19 | 19 | 3→3 | 0→0 |
| verify-api-oauth-ipc-authorization | 15 | 16 | 0→0 | 0→1 |
| verify-credential-ssh-remote-ipc-authorization | 48 | 52 | 4→4 | 0→3 |
| verify-webdav-conditional-write | 5 | 5 | 0→0 | 0→0 |
| verify-remote-workspace-theme | 15 | 19 | 4→6 | 0→0 |
| verify-workspace-isolation | 9 | 14 | 2→2 | 0→1 |
| verify-task-board | 8 | 8 | 0→0 | 0→0 |
| verify-product-experience | 33 | 33 | 0→0 | 0→0 |
| verify-draw-image-ops | 25 | 25 | 0→0 | 0→0 |
| verify-ssh-store-modules | 15 | 15 | 1→1 | 0→0 |
| verify-ssh-reconnect-logs | 8 | 8 | 1→1 | 0→1 |
| verify-motion-levels | 42 | 42 | 4→4 | 0→0 |

**判定口径：`assert*` 条数 + `throw new Error` 守卫数之和不得下降，否定断言数不得下降。
27 个门禁全部通过（脚本实测输出 `NO DROPS`）。**

否定断言的计数口径本轮修正过一次，必须说明：第一版只数 `doesNotMatch` / `assertNotIncludes`，
漏掉了 `assert(!/…/.test(...))`（browser-cookie-import:62,63）与 `assert.ok(!…)`
（remote-workspace-theme:68,69,70,75）这两类**首参取反**形式，把它们误报成 0。
修正后正则覆盖首参取反 + 具名否定 helper + `notEqual` 系列。
因此 `verify-remote-workspace-theme` 的否定断言实为 **4→6**，本表早先版本记的 3→4 是低估，已更正。

所有增长都不是格式解耦带来的，逐项说明来源：

**Phase 2/3 功能新增（早于本轮反向验证）**

- `verify-remote-authorization` 27→82：Phase 3 要求「扩展该门禁覆盖任务路径」，新增 mesh 任务派发授权断言（27→79）；本轮 G 组修 B11 再加 3 条绑定断言（79→82）。
- `verify-remote-workspace-theme` 15→19：Phase 2/3 新增 taskInbox 覆盖，加上本轮把新键校验扩到 16 语言（见下）。
- `verify-chat-experience` 43→65：把合取式拆成多条同 label 断言，要求的事实集合不变，条数增加。

**本轮反向验证修复带来的增长（每条都对应一个实测可利用缺陷）**

| 门禁 | 增长 | 来源 |
| --- | --- | --- |
| verify-workspace-isolation | 9→14 | C8 两站点各自绑定、C9 两站点各自锚定、C10 五个调用点全覆盖 |
| verify-credential-ssh-remote-ipc-authorization | 48→52 | SSH 3 参工作区作用域、三个 sender-trust 函数体逐项断言 |
| verify-terminal-owner-isolation | 21→24 | C2 补 workspace 比较、C3 补两个 helper 缺失的 webContents 操作数 |
| verify-cron-skipped-runs | 20→21 | B13 一条文件级断言拆成持久化与事件载荷两条 |
| verify-api-oauth-ipc-authorization | 15→16 | D6 一条文件级断言拆成两个站点 |
| verify-credential-injection-authorization | 14→15 | C6 补「强制判断」断言（原先只有签名） |

`throw new Error` 守卫的增长（browser-workspace 4→5、remote-authorization 0→1、mcp 0→1、
terminal 0→2、desktop 0→1、api-oauth 0→1、credential-ssh 0→3、workspace-isolation 0→1、
ssh-reconnect 0→1）全部是**窗口界定助手在 channel/函数缺失时 fail-closed**，
不是把原有断言换成 throw。判定口径因此取「assert* + throw 之和」，避免误判。

`verify-browser-workspace-authorization` 两侧 assert* 都是 0，因为它用 `throw new Error` 守卫而非 `assert*`。
原有 4 处守卫全部保留，本轮修窗口时新增 1 处（channel 不在任何注册内时 fail-closed）。

**计数断言未被放宽**：`navRail.remote` 仍要求恰好 1，`UNTRUSTED_IPC_SENDER` 仍 `>= 2`，
`authProvider` 仍精确计数 2。否定断言总数只增不减。

## 反向验证抓到的真实缺陷：折叠文本上的固定字符窗口

这是本阶段最重要的发现，**不是格式问题，是安全门禁被空洞化**。

`tools/verify-browser-workspace-authorization.ts` 原本这样取 handler 窗口：

```ts
const start = source.indexOf(channel)
const handler = source.slice(start, start + 1800)
if (!handler.includes('await isAuthorizedBrowserWorkspace(input.workspaceId)')) throw …
```

迁移时把 `source` 换成折叠文本，窗口仍是 1800 字符。但**折叠会缩短文本**，
于是 1800 个折叠字符覆盖的原始代码比原来更多 —— 窗口够到了相邻 handler。

实测：从 `'browser:export-cookies'` 到**下一个** handler 的授权调用，折叠后只有 **658 字符**，
远在 1800 窗口之内。

**破坏实验**：只删掉 export-cookies handler 的 `!(await isAuthorizedBrowserWorkspace(input.workspaceId))`
合取项（保留其余两个 handler 不动），跑门禁 → **exit 0，仍然绿**。
门禁把 import-cookies 的授权调用当成了 export-cookies 的证据。一个 cookie 导出路径失去工作区授权，门禁不会报警。

**修复**：窗口改为由注册标记界定，而不是字符数。

```ts
const registrations = [...source.matchAll(/register(?:TrustedBrowser)?MessagePackHandler/g)].map(
  (match) => match.index as number
)
const owner = registrations.filter((index) => index <= start).at(-1)
const next = registrations.find((index) => index > start)
const handler = source.slice(owner, next ?? source.length)
```

这既是 token 锚定（重排版无法移动它），又精确等于该 handler 自己的注册块。
文件里共 20 处 `registerTrustedBrowserMessagePackHandler` + 2 处 `registerMessagePackHandler`，都被用作边界。

**修复后复验**（`/tmp/ola-sem-M` 隔离副本，真实 width-100 格式）：

| 破坏 | 退出码 | 报错 |
| --- | --- | --- |
| 删 export-cookies 授权 | **1** | must authorize the target workspace in Main |
| 删 import-cookies 授权 | **1** | must authorize the target workspace in Main |
| 删 clear-cookies 授权 | **1** | must authorize the target workspace in Main |
| 全部还原 | **0** | 通过 |

还原用 `cmp` 确认字节一致。修复后的门禁在 width-100 与 width-60 下均 exit 0。

**同类风险已全仓排查**：`tools/*.ts` 中已无**折叠文本上的固定字符数窗口**（上面那处是唯一的）。
排查用的是 `grep -nE "\.(slice|substring|substr)\(" tools/*.ts`，逐条核对剩余命中：

- `verify-browser-workspace-authorization.ts:24` —— 修复后的 `slice(owner, next)`，token 锚定，不是字符数窗口。
- `verify-desktop-ax-gate.ts:117,124,133` —— **原文**逐行扫描（`text.slice(start, end)`、`.slice(1, -1)` 去首尾），
  属下一节的残留耦合，不是折叠文本窗口。
- `verify-mcp-tool-naming.ts:146,147` —— 数组切片，用于工具预算边界测试，与文本窗口无关。
- `verify-skill-quality.ts:36,38,45` —— 字符串解析切片（按分隔符取 key/body），与文本窗口无关。

剩余的 `{0,N}` 邻近窗口见「残留耦合」一节。

## Phase 6.1 架构边界反向验证（计划明确要求）

计划：「迁移后必须反向验证该边界仍然生效（临时在 runtime 里 import electron，门禁要红）」。

第一次尝试失败：`/tmp/ola-biome-probe` 只拷了 `biome.json`，Biome 报
`couldn't find an ignore file in the following folder`。原因是 `biome.json` 的
`vcs: { enabled: true, clientKind: "git", useIgnoreFile: true }` 要求存在忽略文件。
把仓库 `.gitignore` 拷进探针目录后正常。

探针放三个文件，跑 `biome lint src`：

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| `src/runtime/core/probe.ts` | `import { app } from 'electron'` | **被拦**：The TS runtime must stay independent of Electron. |
| `src/runtime/core/probe2.ts` | `import { create } from 'zustand'` | **被拦**：The TS runtime must stay independent of renderer stores. |
| `src/renderer/src/probe.ts` | `import { app } from 'electron'`（对照组） | **未被拦** |

`BIOME_EXIT=1`，`Found 2 errors`，两条都是 `lint/style/noRestrictedImports`。
3 个文件只报 2 个错，证明规则精确作用于 runtime glob 而非全仓禁 electron。
**边界在 Biome 下仍然生效。**

## 16 语言覆盖：从「只查 en/zh」扩到真正强制

计划 Phase 2.1 要求「16 语言文案；扩展 `tools/verify-remote-workspace-theme.ts` 的 key 列表」。
审计发现该门禁原本只校验 `en` 与 `zh`，所以 16 语言要求实际上没有被任何门禁强制。

实测 16 个 locale（ar de en es fr id it ja ko nl pt ru th tr vi zh）的 `layout.json`：

- **本轮新增的 7 个键全部 16 语言齐备**：`controlInputHint`、`meshTaskTitle`、`meshTaskFrom`、
  `meshTaskAccept`、`meshTaskReject`、`meshTaskRunning`、`meshTaskAttendedNote`。
- **7 个 `meshTaskReason.*` 也全部 16 语言齐备**：unknown-task、already-decided、user-rejected、
  access-disabled、session-busy、confirmation-required、quota-exhausted。
- **15 个旧键在同样的 14 个非 en/zh locale 缺失**（connectionStatus、screenSharing* 系列、
  sameAccountDevices、online/offline/connecting、connectWithoutPassword、disconnectSession、
  serviceEndpoint、cancel）。

用 `git show HEAD:` 核对：这 14 个 locale 在 HEAD 就缺这些键（抽查 3 个键 = 42 处缺失，HEAD 与工作树一致）。
**是既有缺口，不是本轮引入**，也正是该门禁当初只查 en/zh 的原因。

处置：把键列表拆成 `legacyRemoteKeys`（15 个，仍只在 en/zh 校验，文件内注明既有缺口）与
`requiredRemoteKeys`（7 个新键，**全部 16 语言校验**），`meshTaskReason.*` 同样 16 语言。
门禁跑通：`remote workspace theme verification passed`。

没有顺手去补 15×14 = 210 条旧翻译 —— 那超出本轮范围，且会引入未经核对的译文。缺口在此明确记录。

## 残留耦合（已知，未修，width-60 下实测仍绿）

不是所有空白依赖都能在不改变语义的前提下解耦。以下三处**刻意保留原文读取**：

1. `tools/verify-ai-coding-terminal.ts` 的 3 条否定断言。
   `/command\s*=.*(?:apiKey|baseUrl|modelId)/` 与 `/console\.(?:log|warn|error).*apiKey/` 的 `.` 不跨行；
   `/AI_CODING_TERMINAL_LAUNCH[\s\S]{0,500}TERMINAL_INPUT/` 是 500 **原始**字符邻近窗口。
   折叠会把前两者扩成全文匹配、把后者窗口放大，从而**改变禁止范围** —— 那是弱化，不是解耦。
   故保留 `readSource()`，文件内有注释说明。
2. `tools/verify-desktop-ax-gate.ts`：`readFileSync` 原文 + `{0,60}` / `{0,120}` / `{0,200}` 邻近窗口（5 处）。
3. `tools/verify-sync-page-loading.ts`：`readFileSync` 原文 + `{0,500}` / `{0,120}` 窗口。

后两者不在 27 个变红门禁之列，width-60 扫描中均 green，说明这些具体模式在该宽度下存活。
但它们**原则上仍与格式耦合**：换更极端的宽度或不同的断行策略可能变红。
`verify:desktop-ax-gate:strict` 用的是同一个文件，因此同样属残留。

另有**无界窗口**一类残留（与上面的原文邻近窗口不同类）：贪婪 `[\s\S]*` 已从 HEAD 的 46 个
降到 13 个，逐个做过锚点重数判定与破坏实验，清单与理由见「第五组缺陷」一节。
其中 `verify-desktop-ipc-authorization:65` 的 head 落在 import 行上，属站点绑定偏弱，
删守卫能抓到、把守卫挪到别的 handler 抓不到，已知未修。

### 全量扫描结果（串行，两个宽度）

并发扫描因共享 esbuild 缓存而不可信（见第五组末节），以下为**串行**重跑结果：

| 宽度 | RED | green | skipped |
| --- | --- | --- | --- |
| 100（真实仓库） | **0** | 73 | 3 |
| 60（`/tmp/ola-fmt-audit` 副本） | **0** | 73 | 3 |

第五组修好的两个门禁在两个宽度下均 green；一度报 RED 的 `verify:browser-cookie-import`
在串行下恢复 green，单独跑亦 exit 0，确认是竞态而非回归。

## 反向验证抓到的第二组缺陷：verify-browser-cookie-import（既有弱点）

A 组对 6 个门禁做了 30 处语义破坏，27 处正确变红，3 处仍绿，全部集中在
`tools/verify-browser-cookie-import.ts` 对 `src/main/ipc/browser-handlers.ts` 的断言上。

**归因已独立复核：两处都是既有弱点，不是解耦引入的回归。**
`git show HEAD:` 显示 HEAD 第 82 行就是 `handlers.includes('exportBuiltInBrowserCookies')`，
第 99 行就是无界 `[\s\S]*`。子代理另外在**原文**与**折叠文本**两种读法下重测，表现一致。

| # | 缺陷 | 破坏实验 | 修复前 |
| --- | --- | --- | --- |
| 1 | 第 81 行 `handlers.includes('exportBuiltInBrowserCookies')` 是**无作用域存在性检查**，被 `browser-handlers.ts:9` 的 import 语句满足 | 把 handler 内真实调用点改名为 `legacyCookieExport`（import 语句不动） | **0（绿）** |
| 2 | 第 100 行 `registerTrustedBrowserMessagePackHandler<\s*\{[\s\S]*workspaceId:…[\s\S]*\}\s*>\(\s*'browser:import-cookies'` 的 `[\s\S]*` **无界**，可从 export-cookies 的 trusted 注册（479 行）一路跨到 import-cookies 自己的 `}>`（493 行） | 把 import-cookies 降级为普通 `registerMessagePackHandler`（丢掉发送方授权） | **0（绿）** |
| 3 | 该门禁从不断言 `isAuthorizedBrowserWorkspace` | 把 export handler 的工作区授权守卫改成 `false` | 0（绿） |

缺陷 2 与上一节修掉的窗口问题**属同一族**：都是「借邻居的证据」。
对照组能说明问题 —— 同一断言里 clear-cookies 用的是紧模式 `\{\s*workspaceId:\s*string\s*\}`，
它的对照破坏**正确变红**。

### 修复与复验

- **缺陷 1**：存在性检查改为**调用点断言**，带上实参：
  `/exportBuiltInBrowserCookies\(\s*event\s*\.\s*sender,\s*input\s*\.\s*workspaceId\s*\)/`。
  import 语句无法满足它。
- **缺陷 2**：`[\s\S]*` → **`[^>]*`**。`[^>]*` 无法跨过注册的泛型闭合 `>`，
  因此不可能从 export 的 trusted 包装起匹配、到 import 的类型字面量结束；
  同时保留对字段集合与顺序的宽容（import 的类型有 profileId / workspaceId / privacyConfirmed 三个字段）。
- **缺陷 3 不修**：它已被兄弟门禁 `verify-browser-workspace-authorization` 覆盖 ——
  该门禁对 export / import / clear 三个 channel 逐一断言授权，且本轮刚把窗口改成注册边界界定。
  实测同一破坏下它 **exit 1**。在两个门禁里重复同一断言没有必要。

修复后复验（`/tmp/ola-sem-M` 隔离副本，真实 width-100）：

| 破坏 | cookie 门禁 | workspace-authorization 门禁 |
| --- | --- | --- |
| M1 export 调用点改名 | **1** | — |
| M2 import-cookies 降级为不可信包装 | **1** | — |
| M3 export 授权守卫置 false | 0（不负责此断言） | **1** |
| 全部还原 | **0** | **0** |

还原用 `cmp` 确认字节一致。修复后的 cookie 门禁在 width-100 与 width-60 下均 exit 0，
`biome format` 与 `biome lint` 均 exit 0。

## 反向验证抓到的第三组缺陷：verify-credential-ssh-remote-ipc-authorization

D 组 52 处破坏里 8 处仍绿，其中两处落在本门禁。两处都已修，且**修复前的绿是本轮一手复现的**，
不是只引用子代理自报。

### 缺陷 4：SSH 工作区作用域从未被断言（借邻居 + 断言了错误的元数）

HEAD 第 50/51 行断言的是 **2 参**形式：

```ts
assert.match(ssh, /ssh:data'[\s\S]*isSshSessionOwnedBy\(event, args\.sessionId\)/)
```

但 `src/main/ipc/ssh-handlers.ts` 里 `ssh:data`(:2655) 与 `ssh:resize`(:2676) 用的是
**3 参工作区作用域**形式 `isSshSessionOwnedBy(event, args.sessionId, args.workspaceId ?? 'local-personal')`。
2 参形式只存在于 `ssh:disconnect`(:2685)。无界 `[\s\S]*` 正好跨过去借了它。

量化证据（折叠文本，`/tmp/ola-sem-M/probe-ssh.mjs`）：

| 测量 | 值 |
| --- | --- |
| `ssh:data` 自己的 listener 跨度 | **629** 折叠字符 |
| 旧窗口首个 2 参匹配距 `'ssh:data'` | **1191** 折叠字符 |

即旧断言匹配到的东西**根本不在被断言的 handler 里**。

| 破坏（去掉工作区作用域，退化为常量 `'local-personal'`） | HEAD 断言 | 修复后断言 |
| --- | --- | --- |
| `ssh-handlers.ts:2655`（ssh:data） | **绿（BAD）** | **红** |
| `ssh-handlers.ts:2676`（ssh:resize） | **绿（BAD）** | **红** |

修复：按注册标记界定 listener（`ipcMain.on(toMessagePackChannel(` 与 `registerSshMessagePackHandler`
两种形式都要进边界正则，否则窗口仍会跑出自己的 handler），再断言真实的 3 参形式。
这与上一节 browser 门禁的修法同族。

### 缺陷 5：三个 sender-trust helper 的函数体只被文件级断言覆盖

原门禁在循环里对 credentials / SSH / remote 三者只断言 `ownerWindow.webContents === event.sender`
（文件级），而 `event.senderFrame === event.sender.mainFrame` **只对 SSH 断言了一次**（HEAD 第 26 行）。
后果：credentials 与 remote 两个 helper 的帧校验完全没有保护。

本轮亲自跑的破坏实验（修复前）：

| 破坏 | 修复前 |
| --- | --- |
| `credentials-handlers.ts:63` 帧校验改自比较 | **0（绿）** |
| `remote-handlers.ts:73` 帧校验改自比较 | **0（绿）** |
| `credentials-handlers.ts:57` 返回类型 `boolean` → `string` | **0（绿）** |

修复：新增 `trustedSenderBody()`，用「下一个 ` function ` 声明」界定每个 helper 的函数体，
在**函数体内**逐项断言签名、`): boolean {`、`ownerWindow !== null`、`!ownerWindow.isDestroyed()`、
webContents 操作数、帧操作数；SSH 额外断言 `isTrustedRendererIpcEvent(event)`。
两个操作数都加 `(?![\w])` —— 否则 `event.sender` 会被 `event.senderFrame` 前缀匹配满足（B 组同类缺陷）。

修复后复验（7 处破坏，全部还原并确认字节一致）：

| 破坏 | 结果 |
| --- | --- |
| credentials:63 帧校验自比较 | **1** |
| remote:73 帧校验自比较 | **1** |
| ssh:1472 帧校验自比较 | **1** |
| credentials:62 `event.sender` → `event.senderFrame`（前缀匹配探针） | **1** |
| credentials:57 `boolean` → `string` | **1** |
| ssh:2655 去工作区作用域 | **1** |
| ssh:2676 去工作区作用域 | **1** |
| 全部还原 | **0** |

断言数 **48 → 52**，`throw new Error` 守卫 **0 → 2**（listener/helper 缺失时 fail-closed）。
width-100 与 width-60 均 exit 0，`biome format` 与 `biome lint` 均 exit 0。

## 反向验证抓到的第四组缺陷：远程输入授权守卫可被「反转」绕过（本轮新发现）

计划明令「任务派发与远程输入是两条独立授权路径，不得互相放行」，因此对本门禁剩余的
无界窗口没有停在「记录为残留」，而是逐个实测。结果发现一类**前面四组都没覆盖的破坏方式**：

> 不是删除守卫，而是**去掉取反**。符号仍在原处，裸 token 断言照样满足，但所有权判断已经反了。

| 破坏（`src/main/ipc/remote-handlers.ts`） | 修复前 | 修复后 |
| --- | --- | --- |
| :417 `if (!isRemoteInputSessionOwnedBy(…))` → 去掉 `!` | **0（绿）** | **1** |
| :393 `if (!remoteControlEngine.sessions.isOwnedBy(…))` → 去掉 `!` | **0（绿）** | **1** |
| :417 整个守卫 → `if (false)` | 1 | **1** |
| :393 整个守卫 → `if (false)` | 1 | **1** |

对照组说明问题：**删除**守卫会变红（两个符号各只有一个调用点），所以旧断言并非完全无效；
它漏掉的是**语义反转**。这正是「断言了符号、没断言强制」的典型。

修复：新增 `remoteHandler()`，边界正则 `register[A-Za-z]*MessagePackHandler`
（该文件有三种注册形式：`registerTrustedRemoteMessagePackHandler` 27 处、
`registerRawMessagePackHandler` 2 处、`registerMessagePackHandler` 1 处，漏掉任何一种窗口都会跑出自己的 handler），
断言**带取反、带实参**的完整守卫形式。

### 同族缺陷：SSH 所有者绑定与错误串的三站点借用

顺着同一思路测其余窗口，又抓到 4 处：

| 破坏（`src/main/ipc/ssh-handlers.ts`） | 修复前 | 修复后 |
| --- | --- | --- |
| :1907 `ownerWindowId: ownerWindow.id` → `ownerWindowId: 0`（upload:start 自己的站点） | **0（绿）** | **1** |
| :2113 同上（transfer:start 自己的站点） | **0（绿）** | **1** |
| :2007 upload:cancel 的 `'SSH task is owned by another window'` 改串 | **0（绿）** | **1** |
| :2258 transfer:cancel 的同一错误串改串 | **0（绿）** | **1** |

原因：`ownerWindowId: ownerWindow.id` 有 **3 个站点**（1907 upload:start、2113 transfer:start、
2488 `ssh:import:apply`），错误串也有 **3 个站点**（2007、2028 `ssh:fs:remote-copy:abort`、2258）。
无界窗口接受任意一个站点的证据。修复：六条窗口全部改用 `sshListener()` 按注册边界收口。

`ssh:session:list`(:2713) 与 `ssh:diagnostics:list`(:2739) 的比较式也一并收口 ——
它们实测**原本就能变红**（运算符反转会被抓），收口属加固而非修缺陷，已如实区分。

### 一处实测安全、保留为残留的窗口

`engine.ts` 的 `!this.sessions.isOwnedBy(…)[\s\S]*Remote session is owned by another window`
（本门禁最后 1 处无界窗口）实测**两种破坏都变红**：

| 破坏 | 结果 |
| --- | --- |
| `engine.ts:33` 去掉取反 | **1** |
| `engine.ts:36` 改错误串 | **1** |

原因是该错误串在文件中**唯一**且紧跟首个守卫（:33 → :36），`[\s\S]*` 只能向前，
无法从 :69/:138 的守卫回头借 :36 的串。**窗口紧，不是缺陷**，故保留原样并记为残留。

本门禁最终：断言 **48 → 52**，`throw new Error` **0 → 3**，否定断言 4 → 4，
无界窗口 **11 → 1**（剩 1 处已实测安全）。width-100 / width-60 均 exit 0，biome format/lint 均 exit 0。
累计 17 处破坏全部变红，每处还原后 `cmp` 字节一致、门禁复绿。

## 三组并行修复的独立复核（E / G / H）

子代理自报一律不采信。以下为**我在真实仓库与隔离副本亲自重跑**的结果。

### E 组：terminal / process / desktop 输入

| 缺陷 | 我复跑的破坏 | 结果 |
| --- | --- | --- |
| C2 | `terminal-handlers.ts:102` `owner.workspaceId === workspaceId` → 自比较 | **1** |
| C3 | `terminal-handlers.ts:81` → `event.sender === event.sender` | **1** |
| C4 | `terminal-handlers.ts:235` 守卫 → `if (false)` | **1** |
| C5 | `process-manager.ts:277` `!managed \|\| !isManagedProcessOwnedBy(…)` → `!managed` | **1** |
| C7 | `input-handlers.ts:38` 守卫 → `if (false)` | **1** |

断言数实测：terminal **24**（throw 2）、desktop **14**（throw 1），与自报一致。
两门 width-100 exit 0，width-60 副本与真实仓库 `cmp` 一致，biome format/lint exit 0。
E 组另外自查出 `process:kill`(:256) 同属借邻并一并修复，`DESKTOP_SCREENSHOT_CAPTURE` 原本已受保护未动。

### G 组：remote 授权 / OAuth

| 缺陷 | 我复跑的破坏 | 结果 |
| --- | --- | --- |
| B11 | `input-controller.ts:104` 去掉 `enabledOwnerWebContentsId !== ownerWebContentsId \|\|` | **1** |
| D5 | `oauth-handlers.ts:68`（oauth:start）守卫 → `if (false)` | **1** |
| D6 | `oauth-handlers.ts:79` `existing.sender !== event.sender` → `false` | **1** |

断言数实测：remote **82**（throw 1）、oauth **16**（throw 1）。两门 width-100 exit 0，
width-60 副本 `cmp` 一致，biome exit 0。撤销幂等 behavioural 断言未被触碰。

**G 组的一处诚实纠正值得记下**：`engine.ts:139/144`「直接删 clear 调用」在修复前**已经是 RED**，
该处真正可绕过的是未被断言的守卫（:138、:145）。它按实证结果修，没有假定存在邻位借用。

### H 组：MCP / cron / SSH 日志 / 下载安全

| 缺陷 | 我复跑的破坏 | 结果 |
| --- | --- | --- |
| B12 | `mcp-handlers.ts:90` `event.sender` → `event.senderFrame`（前缀冒充） | **1** |
| B13 | `cron-scheduler.ts:128` 持久化 `status: 'skipped'` → `'error'` | **1** |
| D8 | `ssh-handlers.ts:93` `MAX_SSH_DIAGNOSTIC_ENTRIES = 500` → `5000` | **1** |
| D9 | `feishu-api.ts:7` `MAX_DOWNLOAD_REDIRECTS = 3` → `30` | **1** |

断言数实测：mcp 8、cron 21、ssh 8、network 19，与自报一致。四门 width-100 exit 0，
width-60 副本 `cmp` 一致，biome exit 0。

H 组主动声明的未覆盖项（如实保留）：`feishu-api.ts:102` 的 `redirects + 1` 同样未锚定，
但它不是上限常量，不在指派范围；cron 门禁的 `finishedAt` / `error: reason` 仍是文件级多站点模式。

### F 组：工作区隔离 / 凭据注入 / webview

| 缺陷 | 我复跑的破坏 | 结果 |
| --- | --- | --- |
| C8 | `media-runtime-handlers.ts:535` `task.workspaceId !== workspaceId` → 自比较 | **1** |
| C8 | `:559` 同一比较（第二个 handler）→ 自比较 | **1** |
| C9 | `:444` `getRegisteredWindowWorkspace(grant.window) !== grant.workspaceId` → `===` | **1** |
| C9 | `:465` 同一比较（读文件后复检）→ `===` | **1** |
| C10 | 删除全部 **5** 个 `authorizeDbWorkspace` 调用点（:50/257/391/403/447），**import 保留** | **1** |
| C6 | `credentials-handlers.ts:330` `if (!target.allowed)` → `if (false)` | **1** |
| C1 | `index.ts:1296` 删除 `event.preventDefault()` | **1** |

C10 是「裸 token 被 import 满足」这一类的完整证明：五个调用点全删、import 仍在，
旧断言绿，新断言红。C6 的意义更直接 —— 旧门禁只断言函数**签名**，
把强制判断改成 `if (false)` 仍然绿，即明文密码会被注入到不允许的目标。

断言数实测：workspace-isolation **9→14**（throw 0→1）、credential-injection **14→15**、
webview-security **26→26**（绑定到守卫，条数不变）。三门 width-100 exit 0，
width-60 副本 `cmp` 一致，biome format/lint exit 0。

**F 组自己撞出并修掉的一个折叠陷阱值得记下**：它第一版用 `assertCount` 配**字面量** needle
去数 `authorizeDbWorkspace(workspaceId, …)`，在 width-60 下变红 —— Biome 把实参列表换行成
`authorizeDbWorkspace( workspaceId, … )`，字面量匹配不到。改成带 `\s*` 的正则计数后才格式无关。
这与本文开头两处折叠陷阱同族：**计数断言同样必须容忍空白**。

### 复核中我自己犯的一个错，已纠正

第一次跑 H 组四门时我用了 `npm run verify-mcp-ipc-authorization`（连字符），
npm 报 `Missing script`，四个 exit 1。**那不是门禁变红，是我的脚本名写错了** ——
正确是 `verify:mcp-ipc-authorization`（冒号）。用正确名重跑四门均 exit 0。
记在这里是因为「exit 1」很容易被误读成回归。

### 另一处机制纠正（以及对该纠正本身的再纠正）

我给子代理的简报里写「npm 脚本用 esbuild 打包到 `node_modules/.cache/`」。
E 组指出实际是 `node --experimental-strip-types tools/verify-X.ts`，我据此改了备忘。
**但那次「纠正」是以偏概全**：本轮跑 `verify:ssh-transfer-resume` 时，输出明确是 esbuild 打包。
对 `package.json` 全量实测后确认**两种运行器并存**：

```
verify:* 脚本总数 = 93
  esbuild --bundle … --outfile=node_modules/.cache/ola-verify-X.mjs && node …  = 37
  node --experimental-strip-types tools/verify-X.ts                            = 31
  其余为 staging / 活体 Electron / 构建产物检查                                  = 25

verify:ssh-transfer-resume      => esbuild 打包
verify:ai-coding-terminal       => esbuild 打包
verify:remote-authorization     => esbuild 打包（--external:electron）
verify:terminal-owner-isolation => node --experimental-strip-types
verify:mcp-ipc-authorization    => node --experimental-strip-types
verify:workspace-isolation      => node --experimental-strip-types
```

E 组举的三个例子确实都是 strip-types，我举的例子确实都是 esbuild —— 双方各自都没错，
错在把「我查的这几个」当成「全部」。结论不变（必须用 `npm run`，`npx tsx` 会因 cjs 输出
不支持 top-level await 而失败），但**机制描述必须按脚本逐个核实，不能抽样外推**。
这条教训与下面第五组缺陷同源：抽样绿灯不等于全覆盖。

### 工作树安全

`find src -type f -mmin -30` 为空 —— 四组并行期间真实仓库 `src/` 未被任何子代理触碰。
`git status --porcelain tools/` 显示 31 个门禁文件修改 + `tools/lib/` 未跟踪，与 27 门禁迁移加 Phase 3 新增一致。
一度怀疑有越界改动（一批未指派文件也落在 30 分钟窗口内），逐个查 mtime 后确认它们改于
09:59–10:02，属本轮派发（约 10:20）**之前**的迁移批次，非越界。

## 对并行修复结果的独立核实

27 个门禁分 5 批并行修复。子代理的自报结论一律不直接采信，逐项复核：

- **断言数**：用 helper-aware 正则对 HEAD 与现在逐一计数（上表），无一减少。
- **全局 Biome**：`npx biome format tools/` → 75 文件 exit 0；`npx biome lint tools/` → 76 文件 exit 0。
  不是只查各批自己那几个文件。
- **特征标识符核对**（针对改动最大的 `verify-chat-experience`，288→376 行）：
  先尝试比对断言 message 集合，但提取正则跨行匹配到代码碎片，结果不可用 —— 这一步作废，不作为证据。
  改用标识符级核对：`ResizeObserver`、`getMessageAnchorCorrection`、`ModelSwitcher`、`categorySummaries`、
  `ToolPresentationRegistry`、`buildUserMessageContent`、`modelExplicitlyRejectsVision`、`supportsVision`、
  `VisionInputUnsupportedError`、`activeTurn`、`collapseMotion` 共 11 个，
  **HEAD 与现在的出现次数逐一相同**（1/2/1/1/1/1/2/1/3/1/1）。
  字面量变成了带 `\s*` 的正则，但被断言的事实一个没丢。
- **工作树安全**：并行任务启动后 15 分钟内 `find src -type f -mmin -15` 为空 ——
  真实仓库 `src/` 未被任何子代理触碰，用户未提交的远控工作未受干扰。所有破坏实验都在 `/tmp` 隔离副本里做。

## 反向验证抓到的第五组缺陷：四组范围之外的两个门禁（本轮收尾新发现）

四组并行修复覆盖的是 27 个已迁移门禁中被点名的那些。收尾时我没有直接采信「全量扫描绿」，
而是对**所有残留无界窗口**逐个做判定，结果在两个此前未被任何一组覆盖的门禁里又抓到 3 处真实缺陷。

### 判定方法：先算锚点重数，再做破坏实验

贪婪窗口 `head[\s\S]*tail` 的匹配范围是「**第一个** head 站点 → **最后一个** tail 站点」。
由此得到一个便宜的判据：

- tail 唯一且 head 唯一 → 跨度被钉死，**不可能**借邻居证据（PINNED）。
- tail 多站点 → 窗口会一路跑到最后一个站点，可能落在**别的函数**里 → 必须实验。
- head 多站点 → 窗口从**最早**那个站点起算，那个站点可能与被断言的守卫毫无关系 → 必须实验。

先用脚本量出每个残留窗口的 head/tail 站点数（`/tmp/ola-fmt-probe/anchors.mjs`，
按各门禁自己的 bounding helper 复现其实际看到的文本），再只对 CHECK 项做破坏实验。
16 个残留窗口里 7 个判为 CHECK，实验后 3 个是真缺陷、4 个安全。

### 缺陷 6：SSH 续传默认值可以整段删掉而门禁仍绿

`tools/verify-ssh-transfer-resume.ts` 原文：

```ts
assertMatch(main, /async function uploadLocalPath\([\s\S]*resume = false/, 'uploadLocalPath resume')
```

`resume = false` 在 `ssh-handlers.ts` 里有 **6 个站点**（1040/1074/1092/1135/1148/1222）。
`uploadLocalPath` 起于 1070、自己的两个站点是 1074 与 1092，但贪婪窗口一路跑到 **1222**
——那是 `copyRemotePath` 的默认参数。实测：

| 破坏 | 修复前 | 修复后 |
| --- | --- | --- |
| 1074 + 1092 全改 `resume = true`（uploadLocalPath 自己的续传语义彻底消失） | **0（绿）** | **1（红）** |
| 1135 + 1148 全改 `resume = true`（downloadRemotePath 同上） | **0（绿）** | **1（红）** |
| 1222 改 `resume = true`（copyRemotePath，对照组） | 1（红） | 1（红） |

对照组本来就红，因为它是文件里最后一个站点、窗口无处可借 —— 这恰好反证了前两处的借用机制。

**修复**：按顶层函数声明切出各自函数体（声明锚点是行式的，在原文上定位后再折叠），
断言变成 `assertMatch(functionBody('uploadLocalPath'), /resume\s*=\s*false/)`。
顺带把整个门禁从 `readSource` 迁到折叠文本：原来 `args.resume === true` 是字面量计数、
`request: \{ \.\.\.args, resume: true \}` 等是单空格模式，都属格式耦合。
计数改为 `\s*` 容错正则（第三处折叠陷阱：Biome 会把成员链折成 `args .resume`）。
断言数 15→15、否定 1→1、新增 1 个 missing-function throw 守卫，无下降。

### 缺陷 7：AI coding 配置列表的守卫被 259 行的无关站点顶替

`tools/verify-ai-coding-terminal.ts:37` 原文：

```ts
assert.match(dock, /!sshConnectionId\s*&&[\s\S]*aiCodingConfigs\s*\.\s*map/)
```

这是 **head 多站点**变体。`!sshConnectionId &&` 在 `ProjectTerminalDock.tsx` 里有 5 处
（259/285/457/469/584），真正守卫 AI coding 列表渲染的是 **469**，紧接 470 的 `aiCodingConfigs.map`。
贪婪窗口从最早的 **259**（一个完全无关的 early-return）起算，一路到 470。
实测把 469 的 `{!sshConnectionId &&` 改成 `{true &&`：**修复前 0（绿）**。

**修复**：改成紧邻绑定，去掉无界窗口本身：

```ts
assert.match(dock, /!sshConnectionId\s*&&\s*aiCodingConfigs\s*\.\s*map/)
```

守卫必须**紧贴**它所保护的列表，语义比原来更强。修复后同一破坏 **1（红）**。
断言数 15→15、否定 4→4，无下降。该文件刻意保留的 3 条原文否定断言未动。

### 四个实测安全、保留为残留的窗口

不是所有 CHECK 都是缺陷。以下四处破坏实验**正确变红**，故保留原样并记录理由：

| 窗口 | 为什么安全 | 对照破坏 |
| --- | --- | --- |
| `verify-agent-run-owner-authorization:14` | tail `runId: run.runId` 有 2 站点（533/880），但 533 在 head（879）**之前**，贪婪窗口无法回溯 | 880 改名 → 红 |
| `verify-terminal-owner-isolation:87` | 已绑定到 `terminal:list` handler；tail 在该范围内唯一 | 删 277 的 `owner.workspaceId === workspaceId` → 红 |
| `verify-desktop-ipc-authorization:65` | head 含 import 行（2 站点），但 tail 守卫唯一，删守卫即无匹配 | 17 行守卫改 `if (false)` → 红 |
| `verify-ai-coding-terminal:33` | tail `extraEnvironment` 2 站点（139/172），139 在 head（169）之前 | 位置判定，未破坏 |

`verify-desktop-ipc-authorization:65` 的 head 落在 import 行上，属**站点绑定偏弱**（B 类）：
删守卫能抓到，但把守卫挪到别的 handler 里抓不到。已记录为残留，未在本轮扩大改动面。

### 残留无界窗口实测清单（口径已纠正）

第一次用 `grep -c '\[\s\S\]\*'` 数出「44→22」，**那个数是错的**：它把注释里的散文
（`verify-ssh-reconnect-logs:24`、`verify-browser-cookie-import:107`）和惰性量词
`[\s\S]*?` 一起算了进去，还把同一条正则里的两个量词算成两个窗口。
改用小型扫描器只提取**正则字面量**、区分贪婪/惰性后（`/tmp/ola-fmt-probe/windows.mjs`）：

| | 贪婪 `[\s\S]*` | 惰性 `[\s\S]*?` | 文件数 |
| --- | --- | --- | --- |
| HEAD | **46** | 1 | 11 |
| 四组修复后 | 17 | 3 | 11 |
| 第五组修复后 | **13** | 3 | 11 |

 HEAD 的 46 个贪婪窗口分布：terminal-owner-isolation 13、credential-ssh-remote 11、
desktop-ipc 5、ssh-transfer-resume 4、ai-coding-terminal 3、api-oauth 3、remote-authorization 3、
browser-cookie-import 2、agent-run-owner 1、ssh-reconnect-logs 1。

现在剩下的 13 个贪婪窗口：remote-authorization 3（均已绑定到函数体/方法体内部）、
ai-coding-terminal 2、terminal-owner-isolation 2（同一条正则）、ssh-transfer-resume 1（store 内 PINNED）、
agent-run-owner 1、api-oauth 1、credential-ssh-remote 1、desktop-ipc 1、ssh-reconnect-logs 1。
3 个惰性窗口：workspace-isolation 2（同一条正则，F 组新增，惰性以尾 token 为界，比贪婪安全）、
skill-quality 1（解析 Markdown frontmatter，**不是安全窗口**，HEAD 即有、未动）。

### 并发扫描的缓存竞态：一次假 RED，以及它对证据有效性的影响

收尾时我把两个宽度的全量扫描**并发**跑，两边都报
`verify:browser-cookie-import` → `SyntaxError: Unexpected identifier 'registration'`。
单独重跑该门禁是**绿的**，文件 mtime 仍是 10:11:48（本轮未编辑）。

根因：`/tmp/ola-fmt-audit/node_modules` 是指向真实仓库 `node_modules` 的**符号链接**，
而 37 个 esbuild 门禁都把产物写到 `node_modules/.cache/ola-verify-X.mjs` ——
两个宽度共用同一批产物路径。`esbuild … && node …` 之间没有隔离，
A 的 esbuild 写完、B 的 esbuild 覆盖、A 的 node 读到 B 的半成品 → 任意 token 上的 SyntaxError。

**这不只是假 RED**：同一竞态也可能让 width-60 的扫描执行到 width-100 源码打出的 bundle，
即**并发跑出的两个宽度的结果都可能被交叉污染**。因此本轮所有并发扫描结果一律作废，
改为**串行**重跑（先 100 后 60），以串行结果为准。
教训与第五组缺陷同源：**绿灯本身也要问「它是怎么亮起来的」**。

## 尚未覆盖

- **3 个 skipped 门禁**（runtime-main-assets、ts-runtime-production、settings-typecheck）需要真实构建产物。
  本轮收尾做了一次**临时本地构建**（`npm run build` exit 0）后三者**全部实跑 exit 0**，
  详见 `2026-11-12-utilityprocess-isolation.md` 的「本地构建解开的 3 个 skipped 门禁」。
  但它们的文本断言仍未纳入 width-60 测量（扫描脚本固定 skip 这三个），
  且构建产物是临时验证用、不作为交付物保留，因此**常态 CI 之外的复现仍需先构建**。
- **残留耦合的 3 处**（上一节）未解耦，只证明了 width-60 下存活，未证明任意宽度下存活。
- **13 个残留贪婪窗口**已逐个判定：4 个经破坏实验证明安全、其余为 PINNED 或已绑定到函数体内部，
  但 `verify-desktop-ipc-authorization:65` 的 head 落在 import 行上，站点绑定偏弱，已知未修。
  判定只覆盖「删除/中和被断言证据」这一类破坏，未穷举「把证据挪到别处」的重排类破坏。
- **`verify-agent-run-owner-authorization.ts` 未接入 `source-text` 库**：它用裸 `readFile` +
  单空格模式（`/function trusted\(event: IpcMainInvokeEvent\): boolean/` 等），仍属格式耦合。
  width-60 下实测 green，且其唯一贪婪窗口经破坏实验证明安全，故本轮未扩大改动面。
  67 个 `tools/verify-*.ts` 中 29 个已接入 lib（27 个用折叠文本），其余多为 staging/构建产物检查。
- **15 个旧 remote 键 × 14 个 locale = 210 条翻译缺口**未补，属既有问题。
- 本次测量只覆盖 `verify:ci-core` 链 + `verify:ts-migration-ledger`。
  其余 15 个 `verify:*` 脚本是 staging / 活体 Electron / 构建产物检查，不是源码文本门禁，未纳入。