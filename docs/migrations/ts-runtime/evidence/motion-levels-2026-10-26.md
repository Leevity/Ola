# 动效三档产品级验收（2026-10-26）

范围：R6.4a。Windows x64、源码构建 `out/`、隔离 Electron 数据根、简体中文界面、`#/settings/common/general`。

## 采集方式

一次性 CDP 脚本驱动真实 Electron 窗口（`out/main/index.js`，独立 `--user-data-dir`，`--remote-debugging-port`，与 `scripts/verify-electron-startup.mjs` 相同的启动方式）：先 `Emulation.setEmulatedMedia` 设定 `prefers-reduced-motion`，再重载使 `motion/react` 在挂载时读到该值，随后在设置页依次点选三档，读取探针元素的计算样式并 `Page.captureScreenshot`。探针自带 `transition: transform 400ms linear, opacity 400ms linear` 与一个 `@keyframes` 动画，因此读数是三档实际生效的结果，而不是样式表里的期望值。

每个媒体状态重载一次是必要的：`useReducedMotion()` 在挂载时取值，运行时改媒体不会回溯。

## 读数

宿主系统本身声明了「减少动效」（`prefers-reduced-motion: reduce` 为 true），所以两种媒体状态都要采集。

| 系统偏好        | 用户选择 | `data-motion-level` | `transition-property`    | 时长  | 自定义动画 | `scroll-behavior` |
| --------------- | -------- | ------------------- | ------------------------ | ----- | ---------- | ----------------- |
| `no-preference` | 完整     | `full`              | `transform, opacity`     | 0.4s  | 保留       | `smooth`          |
| `no-preference` | 减弱     | `reduced`           | 仅 `opacity`/颜色/阴影类 | 0.14s | 关闭       | `auto`            |
| `no-preference` | 关闭     | `off`               | `none`                   | `0s`  | 关闭       | `auto`            |
| `reduce`        | 完整     | `reduced`           | 仅 `opacity`/颜色/阴影类 | 0.14s | 关闭       | `auto`            |
| `reduce`        | 减弱     | `reduced`           | 仅 `opacity`/颜色/阴影类 | 0.14s | 关闭       | `auto`            |
| `reduce`        | 关闭     | `off`               | `none`                   | `0s`  | 关闭       | `auto`            |

三档梯度成立：`full` 保留位移与动画，`reduced` 只保留淡入淡出（0.14s 反馈时长），`off` 全部为 0 并关闭平滑滚动。系统偏好是地板而非天花板——把用户选择抬回 `full` 不会被覆盖，但在 `reduce` 下「完整」也降为 `reduced`，与 `resolveMotionLevel()` 的注释和单测一致。

## 证据文件

- `motion-level-cascade-2026-10-26T19-01-15.json`：六个组合的完整读数与截图路径
- `motion-level-no-preference-{full,reduced,off}-2026-10-26T19-01-15.png`
- `motion-level-reduce-{full,reduced,off}-2026-10-26T19-01-15.png`

每张截图都是 1280×900 的整窗截图，拍摄前把动效分组滚动到视口中央（`role="radiogroup"` 的 `getBoundingClientRect()` 从 `top: 2514px` 移到 `top: 429px`，落在 900px 视口内），因此能看到三档选择器里当前高亮的那一项。

六张图去重后只有四种画面：

- `no-preference/reduced` 与 `reduce/reduced` 完全相同（高亮「减弱」）
- `no-preference/off` 与 `reduce/off` 完全相同（高亮「关闭」）
- `no-preference/full` 与 `reduce/full` 都高亮「完整」，但两张图并非同一帧：逐像素比对有 317 个像素不同，集中在 y=711…879

**截图不能证明地板语义。** 静态图看不见过渡时长，所以 `full` 在 `reduce` 下被压成 `reduced` 这件事，证据是上面表格里的计算样式（`transition-property` 只剩 `opacity`、`scroll-behavior` 回到 `auto`、自定义 `@keyframes` 变 `none`），不是截图。同理，三档之间「看起来差不多」也不代表未生效——差别在时长与属性集合上，需要读计算样式或实际录屏才能感知。

高亮项跟随的是用户存储的选择，不是生效档位：`reduce/full` 截图里「完整」仍显示为选中，但探针读数是 `reduced`。这是 `useMotionLevel()` 区分「意图」与「生效值」的可见证据。

## 代码级对应

- `npm run verify:motion-levels` 通过（`tools/verify-motion-levels.ts` 断言 `tokens.json` 的 `levels` 顺序与 Renderer 常量一致，并校验 `sync-ola-design.mjs` 的同步约束）
- `tests/runtime/motion-level.test.ts` 覆盖三档的 profile 与系统地板优先级
- `src/renderer/src/assets/main.css` 的 `[data-motion-level]` 规则与上表读数逐条对应

## 边界

未做真机录屏，也没有验证 120Hz/低端 GPU 下的帧率表现。`reduced` 档下第三方组件（如 toast 库）自带的非 CSS 动画未纳入本次读数——它们不受 `transition`/`animation` 断言的约束，需要逐个组件复核。其他平台未采集。
