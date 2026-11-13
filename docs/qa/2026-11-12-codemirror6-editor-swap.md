# Phase 4：Monaco → CodeMirror 6 换型实测（2026-11-12）

计划见 `~/.qoder/plans/pale-inlet-drum.md` Phase 4。spike 结论为 **GO**：Monaco 现用的
六类能力（TS 语义诊断 / IntelliSense / hover、extraLib 环境声明、多语言、side-by-side 与
inline diff、`CodeEditorHandle`、编辑器 API）全部找到 CM6 等价物，因此执行完整替换，
不是半吊子共存。

## 契约保持不变

- `CodeEditorHandle { undo, redo, focus }` 逐字保留（`CodeEditor.tsx:36-40`）。
- `ViewerProps` / `viewer-registry.ts` / `register-viewers.ts` 零改动。
- 6 个消费点零改动：`fallback-viewer.tsx`、`html-viewer.tsx`、`svg-viewer.tsx`、
  `markdown-viewer.tsx`、`SshFileEditor.tsx`、`SshSftpFilePreview.tsx`。
  唯一改名是 `PreviewPanel.tsx` 的 diff 组件：`MonacoDiffEditor` → `CodeDiffEditor`，
  props 逐字不变（含 `modifiedEditable`、`renderSideBySide`、`isBinary`、2MB/50k 行守卫）。
- diff 守卫的两条占位文案逐字保留：`Binary file — cannot show a diff.` /
  `File is too large to diff in the editor.`

## 体积实测（Rollup 模块图，非字符串嗅探）

口径与 `2026-11-12-perf-baseline.md` 一致：首屏 = entry + 窗口 root 静态闭包。

| 指标 | Monaco（换型前） | CodeMirror 6（换型后） | 变化 |
| --- | --- | --- | --- |
| App 首屏 | 4,185,151 B / 6 chunks | **4,185,121 B / 6 chunks** | −30 B；CM6 首屏贡献 **0** |
| 编辑器引擎 chunk | setup chunk 3,792,663 B | `ts-language-service-*.js` **422,148 B** | **−88.9%** |
| TS worker | `ts.worker` 7,010,026 B | `ts-language-worker-*.js` **6,754,263 B** | −3.6% |
| 构建内 monaco 模块数 | >0 | **0** | 依赖已卸载 |

打开一个文件的懒加载闭包：`CodeEditor-*.js` 6,060 B + 引擎 422,148 B；
`CodeDiffEditor-*.js` 31,638 B + 同一引擎 chunk（共享，不重复付费）。
23 个语言语法包从引擎 chunk 走 dynamic import，按文件语言按需加载。

**首屏零收益是预期内的**：Monaco 此前已全链路懒加载。收益在编辑器 chunk、内存与冷开速度，
不在首屏字节。这一点在计划里已写明，此处用数字确认。

## 能力等价：真实浏览器逐项证据

临时 harness（Vite + 真实组件 + `window.ola` IPC stub，MessagePack 编解码走真实
`shared/messagepack/binary-ipc`）在 Chromium 中挂载 `CodeEditor` 与 `CodeDiffEditor`。
harness 三个文件验证后已删除，不留在仓库。

| 能力 | 证据 |
| --- | --- |
| TS 语义诊断 | fixture 的 `const count: number = 'not a number'` 产生 1 个 `.cm-lintRange-error`；未解析 import 的 2307 被抑制（只留 suggestion 下划线）；`window.ola.desktop.platform` 无诊断 |
| lint tooltip | 文本 `Type 'string' is not assignable to type 'number'.` + `'count' is declared but its value is never read.` |
| hover | `function greet(name: string): string` |
| IntelliSense | 12 个候选，`greet` 排第一 |
| undo / redo / focus | 按钮调用后文档恢复 / 重做；`document.activeElement === .cm-content` |
| Ctrl+click 跳转 | `opened: ["/harness/sibling.ts"]`（IPC 走 `fs:read-file:msgpack`） |
| F12 跳转 | 光标置于 `'./sibling'` 内派发 F12 keydown → `opened: ["/harness/sibling.ts"]` |
| Mod-s 保存 | 主编辑器 `saves +1`；diff 修改侧 Ctrl+S `diffSaves +1`；只读原侧 **不触发** |
| side-by-side diff | 3 个 `.cm-editor`；`cm-merge-a` contenteditable=false、`cm-merge-b` =true；4 条 `.cm-changedLine`、2 条 changedText 渐变下划线、4 个着色 gutter 标记 |
| inline diff | 2 个 editor、0 个 MergeView、2 个 `.cm-deletedChunk`；Ctrl+S 仍 `diffSaves +1` |
| modifiedEditable=false | contenteditable=false，插入文本 `diffChanges` 增量 0 |
| 二进制 / 超大守卫 | 0 个 editor，占位文案逐字命中（超大用 2,000,001 字节 original 触发） |
| 主题切换 | light 下主编辑器与 merge 两侧背景 `rgb(255,255,255)`、文字转深色、gutter 同步；切回 dark 复原；诊断不丢 |
| 语言切换 | ts→json→py→ts：语法 token span 39/9/7/39，error 数 1/0/0/1 |

截图（`docs/qa/assets/2026-11-12-editor/`）：

1. `01-dark-split-diff-diagnostics.png` — dark、side-by-side、TS 红色波浪线
2. `02-lint-tooltip.png` — lint tooltip
3. `03-hover-signature.png` — hover 签名
4. `04-inline-diff-light.png` — light + inline diff
5. `05-binary-guard.png` — 二进制占位

## 换型过程中发现并修掉的四个真实缺陷

1. **模型 URI 进不了 TS program（最严重）**。`createTsLanguageSession` 原先把
   `inmemory://ola/model/<hex>/main.ts` 直接拼进路径，TS 的路径规范化不认 scheme 与
   双斜杠，worker 抛 `Could not find source file`，**整个诊断/补全/hover 全静默失效**。
   现剥离 scheme、盘符与重复斜杠（`ts-language-service.ts`）。修复前挂载编辑器与隔离
   probe 均 0 诊断，修复后 1 error + tooltip + hover + 12 补全。
2. **`window.ola.desktop` 环境声明从未生效**：worker 的 `getScriptFileNames` 列出了
   globals lib，但 `libFiles` 里没有它的 snapshot。补 `libFiles.set(RENDERER_GLOBALS_PATH, …)`。
3. **`Omit<联合, 'id'>` 抹掉变体字段**：改用分布式条件类型 `TsLanguageRequestInput`，
   否则 `content`/`offset` 在 typecheck 下不存在。
4. `tests/runtime/auxiliary-run-session-binding.test.ts` 的 `const events = []` 推断为
   `never[]`，`typecheck:runtime` 红；补 `StreamEvent[]` 标注。

## 反向验证（门禁不是装饰）

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 编辑器引擎上限 | `OLA_MAX_EDITOR_ENGINE_BYTES=1` | 红：`over the 1 byte editor budget` |
| TS worker 上限 | `OLA_MAX_TS_WORKER_BYTES=1` | 红：`over the 1 byte ceiling` |
| monaco 必须为 0 | 临时把判定正则扩到 `@codemirror`（分支级证明） | 红：`monaco is still bundled (31 modules` |
| 编辑器不得进首屏 | 临时在 `App.tsx` 静态 import `CodeEditor` 并重新构建 | 红，四条同时命中：首屏 4,617,546 B 超 4,600,000；`@codemirror contributes 958294 bytes`；`@lezer contributes 113220 bytes`；引擎 3,240,667 B 超 600,000。移除后重建 chunk hash 回到 `App-DLKIf1oe.js`，证明恢复干净 |

## 打包态风险：file:// 下的 TS worker（已实测）

换型最大的打包风险是 Vite worker asset 在 `file://` + 生产 CSP（`worker-src 'self' blob:`）
下能否构造并运行。用 `docs/qa/2026-11-12-editor-worker-file-probe.mjs` 在**真实 Electron
主窗口**（`out/main/index.js`，file:// 加载 `out/renderer/index.html`）里直接构造
`new Worker('file:///…/out/renderer/assets/ts-language-worker-*.js')` 并跑协议：

```json
{ "protocol": "file:", "constructed": true,
  "response": [{ "code": 2322, "severity": "error",
                 "message": "Type 'string' is not assignable to type 'number'." }],
  "error": null }
```

worker 是 classic IIFE 产物，CSP 未拦截，诊断正常返回。**asar 内**的同一路径仍未实测
（见下）。

`electron-builder --dir` 在本机两次 OOM（默认 4 GB 与 `--max-old-space-size=8192`），
崩溃点都在 `searching for node modules`（electron-builder 26.15.3 + Node 25.6.1），
与本轮改动无关（本轮只删依赖、未加依赖）。因此 `verify:packaged-startup` 本机未跑，
打包证据仍走 CI 的六平台 release 矩阵。失败产物 `dist/` 已删除。

## 门禁结果

`typecheck` / `typecheck:runtime` / `lint:ci` / `format:check` / `build` /
`verify:renderer-bundle` / `test:runtime`（334 passed | 7 skipped 文件）/
`verify:electron-startup` 全绿。

## 尚未覆盖

- **6 个消费点未在真实 Electron / SSH 会话里手工冒烟**：证据来自 harness 挂载的真实组件，
  不是产品窗口。PreviewPanel / SshFileEditor / SshSftpFilePreview 的集成路径只过了 typecheck。
- **asar 打包态未验证**：file:// 已实测（见上），但 asar 内路径与 `verify:packaged-startup`
  因本机 electron-builder OOM 未跑。
- worker 冷启动耗时、编辑器内存占用未测；本轮只有体积证据。
  （应用冷启动已有数字：见 `2026-11-12-perf-baseline.md` 的 `firstPaintMs`。）
- diff 现在跟随全局 `lineWrapping`：窄面板里长行会换行（Monaco 默认不换行）。
  两侧换行位置一致、行号对齐已用截图确认，但这是与 Monaco 的可见行为差异。
- 六平台未验证。