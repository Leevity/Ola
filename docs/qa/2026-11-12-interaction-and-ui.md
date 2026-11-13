# 2026-11-12 交互与 UI（Phase 2）

承接 `2026-11-12-perf-baseline.md`。本轮只做计划 Phase 2 的三项，不改远控授权语义。

## 2.1 接通控制端输入

改前：`remote-peer-store.ts` 的 `sendInput` 全仓零调用者，`RemotePage.tsx` 的 `<video>` 是裸元素。
被控侧入站链路（`kind:'input'` → `IPC.REMOTE_INPUT_DISPATCH`）早已就绪，缺的只有控制端这一半。

新增 `src/renderer/src/hooks/use-remote-controller-input.ts`，在 `RemotePage.tsx` 挂载。

### 三个必须解释的设计决定

**1. letterbox 感知归一化。** `<video>` 是 `object-contain` + `aspect-video`，远端屏幕不是 16:9 时元素内会留黑边。
按元素矩形换算会让每次点击偏移半个黑边宽度。改为按实际画面矩形换算：

```
scale = min(rect.width / videoWidth, rect.height / videoHeight)
x = (clientX - rect.left - (rect.width - videoWidth * scale) / 2) / (videoWidth * scale)
```

黑边内的**悬停与点击直接丢弃**（不 clamp），因为把点击 clamp 到边缘等于点了用户没指的地方；
**拖拽出画面则 clamp 到边缘**，这是远程桌面的常规行为。`videoWidth` 为 0（元数据未到）时一律不映射。

**2. 键盘只在视频元素聚焦时转发。** 监听器挂在 `<video tabIndex={0}>` 上而不是 window。
否则用户在 Ola 自己的输入框里打字会被送到远端机器。失焦 / 窗口 blur / 页面隐藏 / 卸载 / 会话失效
都会释放所有按住键与键鼠按钮。

**3. 按住键用 `event.code` 建索引，并原样重放 down 的 payload。** 这是本轮最容易写错的地方：
Main 侧 `input-controller.ts:185` 用 `key + modifiers` 作为 held map 的键。
若按下 `a` 后再按 Shift，松开时 `event.key` 变成 `A`、modifiers 变成 `['Shift']`，
up 的键就与 down 不匹配，Main 的 held map 会泄漏一条，撤销时多发一次 up。
因此 down 时把 `{key, modifiers}` 按物理 `code` 存下来，up 时**逐字重放**。
修饰键自身也从 modifiers 里剔除（按 Control 时不该把 Control 列为自己的修饰键）。

### 其它

- 指针移动用 `requestAnimationFrame` 合并为每帧一次。Main 侧 300 evt/s 是**丢弃**而非排队，
  不合并的话移动会吃掉点击与按键的额度。
- `pointerdown` 时 `setPointerCapture`，拖出元素仍能收到 up。
- 只处理 `isPrimary` 指针，避免多指触控与 Main 的按名 held map 冲突。
- 标点符号走 `text` 事件：`resolveRobotKey`（`desktop-control.ts:66`）只认 KEY_MAP、单字母数字、F1–F12，
  没有 `-` `=` `[` 这些键名。字母数字仍走 `key`，否则 Ctrl+C / Shift+A 会失效。
- 粘贴走 `text`（≤4096，与 Main 的 `MAX_TEXT_LENGTH` 对齐），中文输入法因此可用。
- 右键 `contextmenu` 阻止默认，交给远端。
- **未改 `input-controller.ts`**：限速、owner 校验、held 不变量、撤销路径全部原样。

### 顺带修掉的一个既有缺陷

`remoteVideoRef` 在 `RemotePage.tsx:1335` 声明、`:1375` 的 effect 里用来设 `srcObject`，
但 `<video>` 上**从来没有挂 ref**，那个 effect 一直是空转。本次挂上 ref 后它才真正生效。

## 2.2 采集迁 getDisplayMedia + 尊重显示器选择

改前：渲染侧走 legacy `getUserMedia` + `chromeMediaSource:'desktop'`；
Main 的 `setDisplayMediaRequestHandler` 永远返回 `sources[0]`，且因为渲染侧从不调 `getDisplayMedia`，
那段 handler 实际上是死代码。

- 新增 `remote:capture:select` 通道（`contract.ts` + `messagepack-channel-routing.ts` 白名单 + Main handler）。
  `getDisplayMedia` 的 API 不携带任何 source 提示，所以渲染侧必须**先**告诉 Main 要哪块屏。
  沿用 `registerTrustedRemoteMessagePackHandler` 的 sender-trust 门禁与 `requireExactObject` 校验。
- Main handler 按 `requestedCaptureDisplayId` → primary → `sources[0]` 顺序选，
  找不到就 `callback({})` 让渲染侧的 promise **明确 reject**，而不是挂着不动。
- 渲染侧 `openCaptureStream()`：先 `getDisplayMedia`，失败回退 legacy `chromeMediaSourceId`。
  `probeInFlight` 去重原样保留。
- **没有引入任何系统选择器**，所以无人值守采集不会被交互式选择打断。
- TCC 检查、`setPermissionCheckHandler`、`setPermissionRequestHandler` 均未改。

### 一个看起来像 bug 其实自洽的地方

若选中的显示器在采集前被拔掉，Main 回退到 primary，而 capture store 记录的仍是请求的 displayId。
这不会导致点击落到错误的屏幕：`input-controller.ts:45-47` 用**完全相同的回退规则**
（找不到该 id 就用 primary）解析坐标。两侧回退到同一块屏。

## 2.3 骨架屏统一

`MessageList.tsx` 的三行手搓 `animate-pulse rounded-md bg-muted/50|40|30` 改为 `<Skeleton>`，
保留各自的透明度梯度（`cn` 是 twMerge，`bg-muted/50` 会覆盖 `bg-accent`），视觉零变化。

**计划里这一条的事实需要更正。** 计划写「`reduced`/`off` 下不得 pulse」，
但 `main.css:704-706` 与 `:722-724` 明确在每个 motion 等级下用 `!important` **重新启用** `animate-pulse`
——加载指示是刻意豁免于 motion 阶梯的。换成 `<Skeleton>` 继承的是同一份契约，不存在 motion 回归。

## 验证结果

| 检查                            | 结果                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `npm run typecheck`             | EXIT 0                                                 |
| `npm run test:runtime`          | EXIT 0，332 文件 / **1645 通过** / 10 跳过，19.45s     |
| `npm run lint:ci`               | EXIT 0                                                 |
| `verify:remote-workspace-theme` | EXIT 0（`requiredRemoteKeys` 已加 `controlInputHint`） |
| `verify:remote-authorization`   | EXIT 0                                                 |
| `verify:motion-levels`          | EXIT 0                                                 |
| `verify:chat-experience`        | EXIT 0                                                 |
| `verify:product-experience`     | EXIT 0                                                 |
| `verify:i18n`                   | EXIT 0                                                 |

新增 `tests/runtime/remote-controller-input.test.ts`，15 个断言，覆盖 letterbox/pillarbox 几何、
元素偏移、无黑边、元数据未到、键分类，以及**把 `REMOTE_NAMED_KEYS` 绑定到 Main 的真实 `KEY_MAP` 源码**
（用 Phase 0.2 的 `collapseWhitespace`，不依赖格式化）。

### 反向验证（两项都必红，恢复后必绿）

| 注入的语义破坏                                  | 结果      |
| ----------------------------------------------- | --------- |
| 从 `REMOTE_NAMED_KEYS` 删掉 `PageUp`            | EXIT 1 ✅ |
| 把归一化改回按元素矩形（即 letterbox bug 本身） | EXIT 1 ✅ |
| 恢复                                            | EXIT 0 ✅ |

### typecheck 抓到的两个真实缺陷

第一版 hook 里 `releaseAll()` 写成 `for (const [button, at] of buttons.values())`——
`values()` 产出的是 `Point` 而不是条目，解构会得到 undefined，**失焦释放按住键这条安全路径会静默失效**。
已改为 `.entries()`。另有一个未使用的 `MODIFIER_NAMES` 常量，已删。
仓库没有 jsdom/happy-dom，这条路径无法单元测试，是 typecheck 而不是测试拦住了它。

## getDisplayMedia 无手势可用性：实测证据

计划最担心的是「无人值守自动采集不能被交互式选择器打断」。
`getDisplayMedia` 在标准 Chromium 里需要 transient user activation，而无人值守采集是从 effect 里发起的、背后没有点击。
这一点不能靠推断，所以写了 `docs/qa/2026-11-12-display-capture-probe.mjs` 实测。

实测环境：darwin，`screenPermission: "denied"`（node_modules 里的 Electron 二进制没有屏幕录制授权），
1 块显示器 1920×1080 @2x。

```
getSources            → ok:false "Failed to get sources."      （TCC 拒绝）
handler-error         → "Failed to get sources."               （handler 确实被调用了）
getDisplayMedia:1     → ok:false AbortError "Invalid capture constraints"
getDisplayMedia:stale → ok:false AbortError "Invalid capture constraints"
```

**关键结论：全程没有任何点击或按键，Main 的 handler 依然被调用了。**
若 Chromium 要求 user activation，请求会在到达 handler 之前就以「must be handling a user gesture」类的
`NotAllowedError`/`InvalidStateError` 失败。实际拿到的是 handler 返回空答案导致的 `AbortError`。
→ **无手势不是障碍，无人值守路径不会被 activation 要求挡住。**
→ 同时证明 `callback({})` 会让 promise 干净地 reject 而不是挂死，legacy 回退分支可达。

## 尚未覆盖（不要当成已验证）

- **真实像素采集与多显示器选择**：本机 TCC 对 Electron 二进制是 denied，且只接了 1 块屏。
  「选中哪块屏就共享哪块」只验证了 handler 的选择逻辑与 stale-id 回退，没有验证真实画面。
  需要在授予屏幕录制权限、且接两块以上显示器的机器上重跑 probe。
- **控制端输入的真机双端验证**：点击落点、键盘、滚轮、拖拽出画面、失焦释放，全部只有纯函数级测试。
  hook 的事件 wiring 没有 DOM 测试环境覆盖。计划要求的「真机/模拟器双端 + 非 16:9 letterbox」仍未做。
- **macOS TCC 拒绝态的应用层表现**：probe 证明了 API 层的行为；
  应用层 `runProbe` 本来就先查 `REMOTE_CAPTURE_PERMISSION` 并抛出友好错误，这条分支未在本轮实跑。
- **coturn TURNS 443**：属 Ola-admin 部署配置，本轮未改其代码。配置说明与验证步骤已补写于
  [coturn TURNS 443 说明](2026-11-12-coturn-turns-443.md)；其中「同时下发 turn: 与 turns:」
  需要约 6 行服务端改动，超出本轮范围，已记为后续项。受限网络下的真实远控端到端仍未执行。
- 骨架屏与远控输入提示的**截图**未附。

## 文案覆盖的一处既有缺口

`remote` 命名空间**只存在于 en/zh**，其余 14 个语言的 `layout.json` 里一个 remote 键都没有
（`scripts/i18n-audit.mjs` 的严格门禁只强制 `settings` 命名空间，其余只报覆盖率）。
本轮把新增的 `controlInputHint` 写进了全部 16 个语言，所以**新文案是 16 语言齐的**；
但整个 remote 命名空间的其余 306 个键在 14 个语言里仍然回退英文——这是本轮之前就存在的缺口，未在此处扩大或修复。
