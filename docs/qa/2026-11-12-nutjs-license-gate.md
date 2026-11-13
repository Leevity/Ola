# Phase 5.0 硬门禁：robotjs → nut.js 的许可与可用性决策（2026-11-12）

**状态：门禁已裁决——用户于 2026-11-13 选择选项 3「保留 `@jitsi/robotjs`」。**
**Phase 5.1 的同步→异步改造不执行**；选项 3 的三项后续已落地（见文末「决策与执行结果」）。

计划原文：「产出 `docs/qa/` 决策备忘。**在你选定前不进入 5.1。**」本文就是该备忘。
下面所有数字都是本轮实测，命令可复现；**三处推翻了计划的前提**，所以先把事实摆正。

## 结论先说

**推荐选项 3：保留 `@jitsi/robotjs`。** 原始换型动机（"robotjs 停滞、nut.js 维护活跃"）
经核实**方向是反的**：robotjs 的预编译发布管线仍在运转，而 nut.js 的免费 fork 已 20 个月无发布、
且没有独立公开源码仓库；官方 nut.js 根本不在公共 npm 上。

换型唯一剩下的实质收益是"异步 API"，而这对 Ola **是成本不是收益**——它会把
`releaseHeldRemoteInputs()` 的同步 fail-closed 撤销路径变成异步队列，
引入计划 5.1 (a)–(f) 六条必须重新证明的安全不变量。

## 三处纠正计划前提

| 计划原说法 | 实测结果 |
| --- | --- |
| robotjs 与 fork「同样停滞」 | **robotjs 未停滞**：`@jitsi/robotjs` 最新 0.6.24 发布于 **2026-07-02**，2025-04 至 2026-07 共 8 次发布。fork 最新 4.2.6 发布于 **2025-03-13**（20 个月前） |
| nut.js「预编译二进制需付费订阅」（隐含免费版要自己编译） | **免费 fork 自带六平台预编译**，且**实测能在 Electron 43 里加载**。付费墙在**官方包**上：`@nut-tree/nut-js` 在公共 npm **404** |
| 换型是为了解决维护风险 | 维护风险**在 nut.js 一侧更大**：fork 的 `repository` 字段指向上游 `nut-tree/nut.js`，而该仓库 `pushed_at = 2024-05-01`，**2.5 年无公开提交**，GitHub 未识别出 license |

## 证据

### 1. 注册表事实（`npm view`，2026-11-12 实测）

```
@jitsi/robotjs        0.6.24   MIT          publish 2026-07-02T05:21:46Z
@nut-tree-fork/nut-js 4.2.6    Apache-2.0   publish 2025-03-13T21:58:18Z
@nut-tree/nut-js      → npm error 404 Not Found (registry.npmjs.org)
```

`@jitsi/robotjs` 发布序列（`npm view @jitsi/robotjs time`）：
0.6.14/15/16 = 2025-04-15、0.6.17 = 2025-07-25、0.6.18 = 2025-10-05、
0.6.20/21 = 2026-01-05、0.6.22 = 2026-04-16、0.6.23/24 = 2026-07-02。

**诚实的限定**：上游近期 commit 全是 CI/依赖维护（`ci: version bump`、
`Pin GitHub Actions to SHA hashes`、`ci: pin to windows-2022`），**不是功能开发**。
但对 Ola 来说这正是需要的那类维护——六平台预编译管线随 Electron/OS 演进继续产出二进制。

官方包的 404 不是网络问题，npm 自己的报错文案就写着需要购买私有注册表访问权
（`https://registry.npmjs.org/@nut-tree%2fnut-js` → 404；社区报错原文：
"To access nut.js packages you must purchase access to their private package registry."）。
官方文档站 `nutjs.dev/docs` 说明私有注册表为 `pkg.nutjs.dev`，需订阅 + auth token；
`nutjs.dev/pricing` 列 Core $20/mo、Solo $75/mo、Team custom。
**pricing 页与 docs 页对"core 是否免费"的表述不一致**（docs 称 core 开源免费、私有包付费），
本轮**没有**实际购买验证，所以价格与免费额度**以你购买时看到的为准**，不作为结论依据。
无论价格如何，**公共 npm 装不到**这一条已足以构成 CI 阻塞。

### 2. 免费 fork 的二进制实测可用（这点必须说清，不能污名化选项 2）

`@nut-tree-fork/libnut` 依赖三个按平台切分的包（`libnut-darwin` / `-win32` / `-linux`，均 2.7.5），
各自 `cpu: [x64, arm64]`，tarball 内直接带 `build/Release/libnut.node`，**无需本地编译**。

darwin 包实测：

```
$ lipo -info libnut.node
Architectures in the fat file: x86_64 arm64

$ nm -u libnut.node | grep -c napi_
44          # 是 N-API，不是 V8-ABI 绑定 → 跨 Electron 版本 ABI 稳定
```

**在真实 Electron 里加载成功**（探针脚本在 /tmp，未写入仓库、未改 package.json）：

```json
{"electron":"43.8.0","node":"24.22.0","modules":"148","arch":"arm64",
 "loaded":true,
 "exports":["dragMouse","moveMouse","getMousePos","mouseClick","mouseToggle",
            "scrollMouse","setMouseDelay","keyTap","keyToggle","typeString",
            "typeStringDelayed","setKeyboardDelay"]}
```

两个推论：

1. **选项 2 技术上今天就能跑**，门禁不通过的理由是维护与供应链，不是能力缺失。
2. libnut 的导出面**与 robotjs 几乎同名同义**（libnut 本就是 robotjs 的后继）。
   也就是说 nut.js 的**异步性来自它的 JS 包装层，不来自原生层**——
   Ola 若只想要原生能力，换 fork 拿不到任何新东西；若想要异步，那是包装层强加的。

许可合规：两个 tarball 都随包附 Apache-2.0 `LICENSE`（已核对正文首行），
**fork 的许可本身没有问题**，问题是没有可审计的公开源码与 issue 渠道。

### 3. 仓库现状：选项 3 的成本比计划估的低

`@jitsi/robotjs` 评估时为 0.6.21，**2026-11-13 已升级到 0.6.24**（`package.json:172` 声明 `^0.6.24`）。
升级后重新实测 `node_modules/@jitsi/robotjs/prebuilds/`，**六平台二进制仍齐备**：

```
darwin-x64+arm64  linux-arm64  linux-x64  win32-arm64  win32-ia32  win32-x64
```

`install: node-gyp-build` + `prebuild: prebuildify --napi` → N-API，
所以 `scripts/postinstall.mjs:26` 把它列入 `prebuiltNativeModules` **跳过 rebuild** 是正确的，
CI 不需要编译器。五个打包触点现状（行号已核实）：

| 触点 | 位置 |
| --- | --- |
| 依赖声明 | `package.json:172` |
| main external | `electron.vite.config.ts:56` |
| asarUnpack | `electron-builder.yml:114` |
| 跳过 rebuild | `scripts/postinstall.mjs:26` |
| release staging | `scripts/package-release-staging.mjs:23` |
| runtime staging | `scripts/package-runtime-staging.mjs:17` |

**计划 5.1 假设要新建适配层，实际适配层已经存在**：
`src/main/ipc/desktop-control.ts:81-96` 的 `getRobot()` 是唯一 choke point，
memoized、`require` 包在 try/catch 里、失败时记 `robotLoadError` 并由
`:98-105` `getRobotUnavailableResult()` 统一降级。全部 12 个 robotjs 调用点都经它取模块。
将来若真要换后端，改动面是这一个函数 + `KEY_MAP`，不是散落的调用点。

## 三个选项对比

| | 选项 1 官方订阅 | 选项 2 免费 fork | 选项 3 保留 robotjs（推荐） |
| --- | --- | --- | --- |
| 能否 `npm install` | **否**，需私有注册表 token | 是 | 是 |
| CI 六平台 release | 需把付费 token 存进 GitHub secret，且**每个贡献者本地装不上** | 可行 | **现状已可行** |
| 上游维护 | 活跃（付费） | npm 20 个月无发布；上游公开仓库 2.5 年无提交 | 发布管线活跃（CI/依赖级） |
| 可审计源码 | 付费后可得 | **无独立公开仓库** | 公开，MIT |
| 预编译六平台 | 有 | 有（darwin 实测加载成功） | **已装齐** |
| 代码改动 | 5.1 全量异步改造 | 5.1 全量异步改造 | **零**（或仅版本号 bump） |
| 安全不变量风险 | 需重证 (a)–(f) | 需重证 (a)–(f) | **不动，现有同步 fail-closed 保持** |
| 现金成本 | 订阅费（价格待你核实） | 0 | 0 |

## 若你选 1 或 2，进入 5.1 前必须先满足

- **选项 1**：确认订阅档位与价格、确认 token 能进 CI secret、确认离线/断网构建策略
  （私有注册表不可达时 release 会直接失败）。
- **选项 2**：接受"无公开源码、无 issue 渠道"的供应链风险，并确认能自行 fork 维护
  `libnut` 二进制；否则一次 macOS/Windows 权限模型变更就可能让远控输入静默失效。
- **两者共同**：5.1 的六条不变量必须逐条给出测试证据，尤其
  (a) `setRemoteAccessMode('none')` 返回后授权已同步清除、
  (d) 新会话授权前必须等释放队列排空。这两条是同步→异步新引入的窗口，
  现有 `tests/runtime/remote-input-controller.test.ts` 的同步断言**不能直接沿用**。

## 选项 3 的三项后续（2026-11-13 已执行）

1. **版本升级 `^0.6.21` → `^0.6.24`：已完成。**
   `package.json:172` 与 `package-lock.json:1854-1857` 均为 0.6.24，
   `resolved` 指向真实 `registry.npmjs.org/@jitsi/robotjs/-/robotjs-0.6.24.tgz`。
   原生模块实测加载成功，Ola 用到的 9 个 API 全部在位
   （`moveMouse`/`mouseClick`/`keyTap`/`typeString`/`scrollMouse`/`setMouseDelay`/`setKeyboardDelay`/`mouseToggle`/`keyToggle`）。

   **纠正本文此前的一处措辞**：原写「拿到 2026-04 与 2026-07 的 CI/平台修复」。
   实测 `gh api repos/jitsi/robotjs/compare/v0.6.21...v0.6.24` 的改动文件只有
   `.github/workflows/ci.yml`、`package.json`、`package-lock.json`——**没有任何原生/源码改动**。
   所以这是纯 CI 与供应链卫生升级（Actions 钉 SHA、runner 钉 windows-2022、dependabot），
   **不含平台代码修复**，运行时行为不变。这既降低了升级风险，也说明它不带来功能收益。
   与本文「证据」一节早已写明的「上游近期 commit 全是 CI/依赖维护，不是功能开发」一致。

   **审计面已实测未变**：`npm audit --omit=dev` 对比 HEAD 与当前工作树，
   `@jitsi/robotjs` 在两侧 advisory 集合里都不存在，其依赖只有
   `node-addon-api` / `node-gyp-build`，也都不在告警里。生产依赖告警总数
   24 → 20，减少的 4 个全部来自 1.5 与 4.3 主动删包，**新增 0 个**。
   口径与镜像端点坑见 `2026-11-12-perf-baseline.md` 的「生产依赖审计面」一节。

2. **`getRobot()` 加载失败上报审计：已完成。**
   `src/main/ipc/desktop-control.ts` 的 catch 分支现在调用 `recordRemoteAudit`，
   action 为新增的 `input_backend_unavailable`（`src/main/remote/remote-audit.ts:14`）。

   **为什么选 remote-audit 而不是 desktop-flow-recorder**：`recordDesktopFlowStep`
   在没有活跃录制时直接 return（`desktop-flow-recorder.ts:81`），会静默丢弃平台级失效——
   那正是「只能靠用户报障发现」的成因。`recordRemoteAudit` 无条件落盘到
   `userData/remote/audit.json` 并可由 `listRemoteAudit` 读出，才是有效通道。
   `getRobot()` 是 memoized 的，所以每进程只记一次，不会刷屏。
   渲染侧没有 action 标签映射，新增变体无需 16 语言文案。

   测试：`tests/runtime/desktop-input-backend-audit.test.ts`（4 个，全绿）。
   因为 `getRobot()` 走 `createRequire`，绕过 Vitest 的 ESM mock 注册表，
   测试改为拦截 `module.createRequire` 工厂本身。
   **反向验证**：临时删掉 `recordRemoteAudit` 调用后，2 个正向断言变红、
   2 个负向对照（加载成功不记、坐标越界不怪后端）仍绿；恢复后 4/4 绿。

3. **架构文档记录「输入后端可替换」：已完成。**
   `AGENTS.md` 的 Key architectural patterns 新增 Desktop input backend 条目，
   写明唯一 choke point 是 `getRobot()` + `KEY_MAP`、失效上报走审计、
   以及截图/几何刻意不用 robotjs 的屏幕像素 API。

## 尚未覆盖

诚实记录，避免把"评估完成"读成"换型验证通过"：

- **只实测了 darwin-arm64 的 fork 二进制加载**。win32 / linux 的 fork 包未下载、未加载测试。
- **没有做任何真实输入注入测试**（未调用 `moveMouse`/`keyTap`），
  所以"能加载"不等于"能正确注入"，更不等于撤销路径正确。
- **官方订阅未购买验证**，价格与免费额度来自网页表述，且两页表述不一致。
- 选项 3 的 robotjs **六平台实机键鼠与撤销验证本轮未做**（现状沿用既有实现）。
- 未评估 nut.js 的屏幕/像素能力——Ola 刻意不用（截图走 Electron `desktopCapturer`，
  几何走 `screen.getAllDisplays`），所以这部分能力差异对 Ola 无意义。

## 决策与执行结果

**用户裁决（2026-11-13）：选项 3 —— 保留 `@jitsi/robotjs`。**

因此 **Phase 5.1 的同步→异步改造不执行**，计划 5.1 的 (a)–(f) 六条不变量无需重新证明：
现有同步 fail-closed 撤销路径原样保留，`releaseHeldRemoteInputs()`、
`authorization-state.ts` 的同步 listener 循环、300 evt/s 限速与 owner 校验均未改动。
Phase 5.2 的 nut.js 打包触点改造同样不执行；5 处既有 robotjs 打包触点保持不变。

选项 3 的三项后续已落地（见上一节），其中版本升级与审计观察项有测试与反向验证证据。

**仍未覆盖（受外部条件阻塞，不要读成已验收）**：

- **六平台实机键鼠与撤销验证未做**：本轮只在 darwin-arm64 验证了模块加载与 API 在位，
  **没有做任何真实输入注入**（未调用 `moveMouse`/`keyTap` 实际动鼠标键盘）。
  「能加载」不等于「能正确注入」，更不等于撤销路径在六平台都正确。
- **六平台打包验证未做**：0.6.24 的预编译产物在 win32/linux 各架构能否加载未实测；
  `postinstall.mjs:25` 对 robotjs 跳过 rebuild、直接用预编译，所以打包态依赖各平台产物齐全。
- 这两项与 Phase 7 的六平台打包验证同属 CI/实机条件，需在 GitHub CI 产出安装包后逐平台执行。