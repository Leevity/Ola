# 远控许可与「控制台 / App 远控 PC」链路改造记录（2026-11-07）

## 1. 背景

上一轮发现「同账户设备连不上」的真正原因不是接口缺失，而是：

- `POST /api/pairing/auto-resolve` 在 Ola-admin（生产控制面）里是存在的，Ola 仓库那份 server 才是旧版；
- 「设备是否允许被远程控制」根本没有落库，只是 Redis `ola:remote:allowed:<deviceId>`（TTL 75s）+ Hub 内存镜像，默认 false；
- 唯一能把许可置 true 的入口是「受控端生成配对码」，且**任何持有账户 JWT 的人都能替在线设备授权**（控制台就是靠这个连上 Mac 的）；
- 控制台设备页只能看画面，不转发鼠标/键盘，所以「服务端远控 PC」实际只能看不能操作。

## 2. 服务端（Ola-admin）

### 三态许可落库

- `server/migrations/021_device_remote_access.sql`：`devices.remote_access_mode`（none/attended/unattended，默认 none，带 CHECK）、`remote_access_updated_at`、`remote_access_updated_by`。
- `server/internal/store/device_access.go`：三态常量、`NormalizeAccessMode`（未知值折叠为 none）、`ValidAccessMode`、可选能力接口 `DeviceAccessStore`。
- memory / postgres 两套实现同步；`Device` JSON 增加 `remoteAccessMode`，因此 `GET /api/devices`、`heartbeat` 都会回传许可。

### 许可语义（关键设计）

| 模式       | 持久 | 生效条件                      | 断线后           |
| ---------- | ---- | ----------------------------- | ---------------- |
| none       | 是   | 永不                          | 保持关闭         |
| attended   | 是   | 需要 75s 租约，heartbeat 续租 | 租约过期即不可连 |
| unattended | 是   | 无需租约                      | 保持可连         |

`api.deviceRemoteAllowed`：unattended 直接 true；none 直接 false；attended 回落 Redis 租约。这样既保住了「有人看着」的短时效，又让无人值守跨断线成立。

### 接口

- `GET/PUT /api/devices/{id}/remote-access`：读/写三态；unattended 必须 `confirm` 等于设备名（`confirmation_required`）；变更写 `device.remote_access.changed` 审计；写后失效 Hub/Redis 缓存。
- `POST /api/devices/{id}/auto-approvals`：无人值守自动批准的审计上报，非 unattended 直接 403（`auto_approval_requires_unattended`），落 `device.auto_approval` 审计。
- `POST /api/sessions/{id}/end`：控制台挂断，与「删除设备」语义分离。
- `POST /api/pairing/create` 硬化：设备为 none 时，只有**设备自己带 `X-Ola-Device-Token`** 才能升到 attended；账户 JWT 单独不够。`OLA_ALLOW_LEGACY_PAIRING_GRANT=1` 是过渡开关（默认关）。

### 测试

`server/internal/httpapi/device_access_test.go` 覆盖：三态生命周期 / 越权 / 非法值 / 确认词 / 审计、pairing 需设备令牌、旧客户端过渡开关、会话挂断归属、自动批准审计门槛。

## 3. 控制台（Ola-admin/src）

- 设备页新增三态许可列与 `DeviceAccessControl`（unattended 需输入设备名确认），`connectGate` 在许可关闭时禁用「连接」。
- 会话表支持挂断、默认隐藏已结束会话、空态引导。
- `Notice` 危险态改用 `role="alert"`。
- **新增 `RemoteViewer`**：把视频从「只能看」升级为「可控」——指针移动（rAF 合帧）、按键、滚轮经 DataChannel 以 `{kind:'input', envelope}` 转发，并带「仅观看 / 控制中」开关；CSS 增加 `is-interactive` 视觉反馈。
- 控制端设备只注册一次并复用（`ola.webControllerDeviceId`），不再每次点击都新增一个「Ola Web 控制端」。

## 4. 桌面端（Ola）

- `authorization-state.ts` 内部改三态，保留布尔包装；`setRemoteAccessMode('none')` 立即清空输入会话并触发撤销回调。
- 新增 `main/remote/access-mode.ts`：进程内唯一权威（mode / 活动会话 / run 绑定 / 12h 200 次自动批准配额）。
- 自动批准链路：`ts-runtime-bridge` 在 run 提交成功后调 `remote:access:bind-run`；`use-runtime-approval` 在弹窗前问主进程 `remote:access:auto-approve`。**只有「会话已开时提交的 run」才可能被自动批准**，本地 run 永远拿不到绑定，也不会写入本地白名单。
- `RemoteControlHost`（挂在 Layout）：常驻连接信令、按许可接收 offer、无人值守时自动拉起屏幕采集、右下角常驻指示 + 一键收回（先本地断输入，再写服务端 none）。
- `remote-peer-store`：收到 offer 时若没有采集流则**按需启动采集**再应答（无人值守时没有任何人能点「共享屏幕」）；`listenForIncoming` 受许可门控。
- 设备页三态控件：关闭 / 我在时允许 / 无人值守（需输入设备名）。
- 新增 `tests/runtime/remote-access-mode.test.ts`（6 项）：初始关闭、撤销即断、未绑定 run 不批、会话结束即停、配额计数、撤销清绑定。

## 5. 未完成 / 风险

- **App（手机端，`ola-mobile`）本轮不改**：用户正在自行完善，暂不介入。协议侧已经就绪——受控端只认「任意控制器开 `control` DataChannel 发 `{kind:'input'}`」，控制台（Web）已按此实现并实机验证；手机端接入时复用同一套报文即可，无需服务端或桌面端再改。
- **run 协议远程下发未做**：本轮只打通「许可 + 画面 + 输入 + 审批自动通过」，没有 `ola-task-v1` 独立通道，远端还不能直接提交 Agent 任务。
- **attended 依赖采集**：受控端停止共享即降级为 none（有意为之）；无人值守由 `RemoteControlHost` 自动重启采集，但若系统层吊销录屏权限则只能报错。
- `dist/mac-arm64/Electron.app` 仍是旧包，需要 `build:unpack` 才会反映这些改动。

## 6. 实机联调（attended / unattended 全链）

环境：本机起 Ola-admin `OLA_REMOTE_DEV_MODE=1`（API `:7300`、信令 `:7301`，内存存储），用真实账号 + 两台真实设备令牌 + 两个真实 WebSocket 对端跑完整链路（信令层是服务端真实代码，不是 mock）。

| #   | 断言                                                                                                                          | 结果 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 新设备默认 `none`，控制台无法在其上开配对（403 `remote_access_disabled`）                                                     | ✅   |
| 2   | `unattended` 缺确认词 → 400 `confirmation_required`；非法值 → 400 `invalid_access_mode`                                       | ✅   |
| 3   | 账户可把设备切到 `attended`                                                                                                   | ✅   |
| 4   | `attended` 设备上报自动批准 → 403 `auto_approval_requires_unattended`                                                         | ✅   |
| 5   | 输入设备名确认后切 `unattended`，`autoApprove=true`                                                                           | ✅   |
| 6   | `unattended` 设备上报自动批准 → 200，落 `device.auto_approval` 审计                                                           | ✅   |
| 7   | 控制台 `create → resolve` 拿到票据，且回传 `remoteAccessMode=unattended` + `autoApprove=true`                                 | ✅   |
| 8   | 控制台 offer 经 Hub 投递到 PC（`from`/`sessionId`/`description` 全对）                                                        | ✅   |
| 9   | PC 的 answer 回投到控制台                                                                                                     | ✅   |
| 10  | ICE candidate 双向中继                                                                                                        | ✅   |
| 11  | `POST /api/sessions/{id}/end` → `live=true`，两端都收到 `close{label:"ended_by_controller"}`                                  | ✅   |
| 12  | 切回 `attended` 后 `create → resolve → offer` 仍可达 PC，`autoApprove=false`                                                  | ✅   |
| 13  | 会话中途撤销为 `none`，下一帧立即被拒（`controlled device is not allowing remote control`），会话按 `permission_revoked` 收尾 | ✅   |
| 14  | 审计含 `device.remote_access.changed` / `device.auto_approval` / `remote_session.ended`，且保留 `from → to` 迁移              | ✅   |

合计 **31/31 通过**。脚本见 `docs/qa/remote-access-e2e.mjs`（直接 `node` 跑，需先起 Ola-admin）。

### 联调发现并修复的缺口

1. **`/api/pairing/resolve` 不回传许可态**（只有 `/api/pairing/auto-resolve` 有）。控制台实际走的是 code 配对，所以拿不到 `autoApprove`，也就无法提示「该设备无人值守、交互会自动批准」。已补齐 `remoteAccessMode` / `autoApprove`。
2. **`/api/pairing/resolve` 未复核耐久许可**：设备在 `create` 与 `resolve` 之间被撤销为 `none`，仍然能换到票据（真正拦截靠 Hub，属纵深防御缺失）。已加复核，撤回后直接 403 `remote_access_disabled`。
3. 复核时踩到的语义坑：`attended` 的租约存在信令层，进程内若拿不到租约源（`remotePermission()==nil`），不能用「租约为空」当成拒绝理由。新增 `pairingAccessDenied` 统一判定——**只拒绝能确证的情况**（`none` 必拒；`attended` 仅在租约源可见且确为 false 时拒），`auto-resolve` 与 `resolve` 共用，避免两条路径语义分叉。
4. 控制台 `RemoteViewer` 增加「无人值守 · 工具调用自动批准」徽标；挂断/删除设备时同步清空画面与徽标，避免旧会话状态残留。

### 复验命令

```bash
# 服务端
go -C server test ./...                      # 全绿
# 控制台
npm run lint && npm run build                # 0 error
npm run test:unit                            # 31 passed
npm run e2e                                  # 15 passed
```

## 6. 实机联调（attended / unattended 全链）

环境：本机起 Ola-admin `OLA_REMOTE_DEV_MODE=1`（API `:7300`、信令 `:7301`，内存存储），用真实账号 + 两台真实设备令牌 + 两个真实 WebSocket 对端跑完整链路（信令层是服务端真实代码，不是 mock）。

| #   | 断言                                                                                                                          | 结果 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 新设备默认 `none`，控制台无法在其上开配对（403 `remote_access_disabled`）                                                     | ✅   |
| 2   | `unattended` 缺确认词 → 400 `confirmation_required`；非法值 → 400 `invalid_access_mode`                                       | ✅   |
| 3   | 账户可把设备切到 `attended`                                                                                                   | ✅   |
| 4   | `attended` 设备上报自动批准 → 403 `auto_approval_requires_unattended`                                                         | ✅   |
| 5   | 输入设备名确认后切 `unattended`，`autoApprove=true`                                                                           | ✅   |
| 6   | `unattended` 设备上报自动批准 → 200，落 `device.auto_approval` 审计                                                           | ✅   |
| 7   | 控制台 `create → resolve` 拿到票据，且回传 `remoteAccessMode=unattended` + `autoApprove=true`                                 | ✅   |
| 8   | 控制台 offer 经 Hub 投递到 PC（`from`/`sessionId`/`description` 全对）                                                        | ✅   |
| 9   | PC 的 answer 回投到控制台                                                                                                     | ✅   |
| 10  | ICE candidate 双向中继                                                                                                        | ✅   |
| 11  | `POST /api/sessions/{id}/end` → `live=true`，两端都收到 `close{label:"ended_by_controller"}`                                  | ✅   |
| 12  | 切回 `attended` 后 `create → resolve → offer` 仍可达 PC，`autoApprove=false`                                                  | ✅   |
| 13  | 会话中途撤销为 `none`，下一帧立即被拒（`controlled device is not allowing remote control`），会话按 `permission_revoked` 收尾 | ✅   |
| 14  | 审计含 `device.remote_access.changed` / `device.auto_approval` / `remote_session.ended`，且保留 `from → to` 迁移              | ✅   |

合计 **31/31 通过**。脚本见 `docs/qa/remote-access-e2e.mjs`（直接 `node` 跑，需先起 Ola-admin）。

### 联调发现并修复的缺口

1. **`/api/pairing/resolve` 不回传许可态**（只有 `/api/pairing/auto-resolve` 有）。控制台实际走的是 code 配对，所以拿不到 `autoApprove`，也就无法提示「该设备无人值守、交互会自动批准」。已补齐 `remoteAccessMode` / `autoApprove`。
2. **`/api/pairing/resolve` 未复核耐久许可**：设备在 `create` 与 `resolve` 之间被撤销为 `none`，仍然能换到票据（真正拦截靠 Hub，属纵深防御缺失）。已加复核，撤回后直接 403 `remote_access_disabled`。
3. 复核时踩到的语义坑：`attended` 的租约存在信令层，进程内若拿不到租约源（`remotePermission()==nil`），不能用「租约为空」当成拒绝理由。新增 `pairingAccessDenied` 统一判定——**只拒绝能确证的情况**（`none` 必拒；`attended` 仅在租约源可见且确为 false 时拒），`auto-resolve` 与 `resolve` 共用，避免两条路径语义分叉。
4. 控制台 `RemoteViewer` 增加「无人值守 · 工具调用自动批准」徽标；挂断/删除设备时同步清空画面与徽标，避免旧会话状态残留。

### 复验命令

```bash
# 服务端
go -C server test ./...                      # 全绿
# 控制台
npm run lint && npm run build                # 0 error
npm run test:unit                            # 31 passed
npm run e2e                                  # 15 passed
```

---

# 第二轮：控制台 ↔ PC 真联通 + 任务进度上屏（同日续）

上一轮把「许可 / 信令 / 输入」打通到「能点能敲」，但画面与任务进度仍是空的。这一轮用真实 Electron + 真实 Chrome 控制台跑端到端联调（Ola-admin 仓库 `.e2e-remote-loop.mjs`），**17/17 全绿**。

## 1. 画面拿不到 video track 的真正原因（不是采集问题）

现象：控制台 `<video>` 永远是 `0x0`，PC 端 answer 的 SDP 只有 `a=group:BUNDLE 0`，即只有一条 `m=application`。

- 单独探测证明采集完全正常：`screen:1:0`、`3840x2160`、30fps。
- 根因在**控制台侧的 offer**：`WebRemoteSession.connect()` 只 `createDataChannel()`，没有声明视频 m-line。PC 端 `addTrack()` 生成的收发器不在 offer 的 m-line 里，JSEP 规定 answer 不能凭空增加 m-line，于是被裁剪掉 → 控制通道正常、画面永远黑。

修复（`Ola-admin/src/remote.ts`）：

```ts
this.peer = new RTCPeerConnection({ iceServers })
this.peer.addTransceiver('video', { direction: 'recvonly' }) // ← 关键
this.channel = this.peer.createDataChannel('control', { ordered: true })
```

answer 立刻变成 `a=group:BUNDLE 0 1`，控制台侧 `videoWidth/videoHeight = 3840x2160`。

## 2. 任务进度上屏（新增能力）

受控端把「本机正在跑什么」投影成一份**快照**，经 DataChannel 的 `{kind:'task'}` 帧推给控制台；控制台用 `RemoteTaskPanel` 渲染。设计要点：

| 关注点 | 处理                                                                        |
| ------ | --------------------------------------------------------------------------- |
| 传输   | 复用既有 WebRTC DataChannel（`control`），不额外开信令通道                  |
| 频率   | 300ms 合并推送；终态立即 flush，不等定时器                                  |
| 体积   | 文本保留尾部 4000 字、单步输出 600 字、步骤上限 40                          |
| 迟到   | 控制台在跑中途连入时，`channel.onopen` 里 `replayRemoteTask()` 补发当前投影 |
| 断线   | `cleanupPeer()` 里 `resetRemoteTask()`，不复用旧会话状态                    |

关键文件：

- `src/shared/remote-control.ts`：`RemoteTaskStep` / `RemoteTaskStatus` / `RemoteTaskSnapshot`
- `src/renderer/src/lib/remote/remote-task-progress.ts`：run 事件 → 投影（`beginRemoteTaskRun` / `publishRemoteRunEvent` / `endRemoteTaskRun` / `replayRemoteTask`）
- `src/renderer/src/stores/remote-peer-store.ts`：`sendTaskSnapshot` + `setRemoteTaskSender` 注入发送器（避免 import 环）
- `Ola-admin/src/components/RemoteTaskPanel.tsx` + `DevicesPage.tsx` + `dictionary.ts` + `console.css`

## 3. 联调暴露、并已修掉的三个产品缺陷

### 3.1 面板被「跑完之后的总结 run」抢走（最关键）

任务一结束，`final-outcome.ts` 会用**同一个 session** 再提交一次 run，让模型输出 `{title, summary}` 的总结 JSON。它复用同一条 run 管线，于是把受控端的面板重置成一个「无步骤、正在跑」的新任务——操作员恰好在任务完成的那一刻丢失全部步骤。表现就是偶发的「no step reported」。

修复：只投影**真正在写助手消息的 run**。

```ts
// ts-runtime-bridge.ts
if (run.assistantMessageId) {
  beginRemoteTaskRun(run.runId, run.prompt ?? '', run.sessionId)
}
```

辅助 run（总结 / 标题 / 翻译 / 优化）都不带 `assistantMessageId`，因此不再污染面板。

### 3.2 同一任务的多个 turn 会清空面板

Agent 循环可能把一次用户请求拆成多个 run（同一 prompt、同一 session）。原来 `runId` 一变就重建投影，操作员看到的是最后一段。

修复：同一 session + 同一 prompt 的后续 run 视为**同一个任务的下一轮**，保留步骤与文本、只把状态推回 running；prompt 或 session 变化才开新任务。

### 3.3 丢掉 generation 事件的工具调用不可见

控制台中途连入、或某次事件被折叠进快照时，只有 `tool.result` 没有 `tool.generated`。原实现会因为找不到对应步骤而整条丢弃。

修复：无对应步骤时补记一条已完成（或失败）的步骤，保证「跑过什么」至少可见。

## 4. 端到端验收（真实 Electron + 真实 Chrome）

脚本：`Ola-admin/.e2e-remote-loop.mjs`（隔离数据根 + 真实 safeStorage 加密凭据 + 真实 WebRTC）。

```
PASS  account login over HTTP
PASS  PC registers itself as a device
PASS  console-side grant of unattended access        mode=unattended
PASS  desktop session seeded (encrypted vault)
PASS  desktop is online in the control plane
PASS  console signs in
PASS  console opens the remote viewer                3840x2160
PASS  media path delivers frames                     3840x2160
PASS  remote input reaches the PC and is dispatched  6 accepted of 6 sent
PASS  PC recorded the input session                  input_enable + 6×input + input_disable
PASS  console shows a task panel for the PC
PASS  task panel echoes the prompt that started the run
PASS  task panel lists the tool steps the PC executed   LS <1s
PASS  task panel streams result text or a terminal status
PASS  task panel follows the run to a terminal state    已完成
PASS  console hang-up ends the session
PASS  PC drops the input session on hang-up
=== 17/17 checks passed ===
```

DataChannel 上岸的任务帧也就一条干净序列（不再有内部 run 的重置帧）：

```
running seq0 → running seq2 → running seq14(LS) → running seq45 → completed seq56(LS 保留)
```

## 5. 复验命令

```bash
# 桌面端
npm run typecheck                       # node + web 均 0 error
npx vitest run tests/runtime/remote-task-progress.test.ts tests/runtime/remote-access-mode.test.ts
# → 21 passed（任务投影 15 项 + 三态许可 6 项）

# 控制台
npm run lint && npx tsc -b               # 0 error

# 端到端（需先起 Ola-admin server 与 vitest dev server）
node .e2e-remote-loop.mjs
```

## 6. 仍然开放

- **控制面下发任务到受控端**（`ola-task-v1` 远程 run 协议）：目前只能「看进度 + 操作鼠标键盘」，还不能由控制台发起 run。
- 手机端按你的要求未改，等你自己那版对齐后接同一份快照协议即可。

---

# 第三轮：全量质量门禁复核（同日再续）

对整个仓库做了一次「门禁全扫 + 修复」：77 个 `verify:ci-core` 子脚本逐个执行、全量 vitest（1627 例）、lint、typecheck，并回归了端到端联调。

## 1. 门禁里挖出的两个真实问题（已修）

### 1.1 `verify:remote-authorization` 与三态许可脱节

三态重构后 `setRemoteControlAllowed(false)` 在「本来就是 none」时不再触发 revoke 通知（这是有意为之：心跳每 30s 回显一次 `none`，若无条件通知，每个 beacon 都会让监听者空转）。但旧校验器仍断言「false 必通知」，导致 `verify:ci-core` 全红。

修复：校验器改为锁定**新契约**，且比原来更严——

- `none→none`（无会话）不通知（幂等）；
- `attended→none` 恰好通知一次，并清掉已授权的输入会话；
- `unattended` 与 `attended` 对输入同等放行，模式值可读回。

### 1.2 `verify:managed-model-bridge` 的 esbuild 桩缺导出

`access-mode.ts` 新 import 了 `setRemoteAccessMode`，但 `scripts/verify-managed-model-bridge.mjs` 里 `./authorization-state` 的 fixture 桩只导出旧的 `setRemoteControlAllowed`，构建直接失败。补上桩导出即绿。

## 2. 任务进度投影的两个边界（已修）

1. **挂断不清除进行中的任务**：控制器挂断时原来无条件 `resetRemoteTask()`，若机器还在跑任务，投影被清空且后续事件全部丢弃（事件过滤要求 `current.runId` 匹配）——下一个连入的操作员会看到空面板直到下一次 run。新增 `resetRemoteTaskIfIdle()`：只清已结束的任务，进行中的任务保留给重连者 replay。
2. **续 turn 合并加窗口**：同 session + 同 prompt 的下一个 run 视为同一任务（保留步骤/文本），但要求上一 run 已到达终态且间隔在 5 分钟内——防止把操作员有意重发的同文案 prompt 合并进旧任务，也防止慢 turn（工具阶段可能数分钟）中途被误开新任务清空步骤。

测试：`remote-task-progress.test.ts` 18 项全绿（新增 3 项：超窗重发开新任务、挂断保留进行中任务、挂断清除已完成任务）。

## 3. 控制台面板两处体验补齐

- **耗时本地走秒**：快照只在 run 事件时到达，模型长思考期间面板会「冻住」，加一个 `!done` 时的本地 1s ticker。
- **等待确认有专属提示**：`waiting_interaction`（有人值守模式下等待本机批准）此前只显示「执行中」+ 普通提示，操作员无法区分「在干活」和「被卡住」。现在显示黄色警示文案（中英文案已入库）。

控制台 `tsc -b` / eslint 0 error。

## 4. 全量 vitest 的 23 个失败：均为沙箱所致，非产品缺陷

4 个文件（`runtime-staging-integrity` 15、`release-sbom` 6、`no-dotnet-artifacts` 1、`skill-runtime-tool` 1）全部失败于 `Error: Brokered file token refused: modify backup failed`——栈顶是 WorkBuddy 的 `node-brokered-fs-shim.cjs`，拦的是 `@electron/asar` 打包与技能目录复制这类「打开备份后重写」的文件操作，换 TMPDIR 无效。需在普通终端复跑确认；不计入产品缺陷。

## 5. 端到端回归

`caffeinate -us node .e2e-remote-loop.mjs` → **17/17**（画面 3840x2160、输入 6/6、任务面板全程跟随到「已完成」且步骤保留）。

⚠️ 环境注意：**显示器休眠会让 `desktopCapturer.getSources()` 返回空**，本轮复现过一次（`WINDOW_CAPTURE_PROBE={"error":"no source"}` → 无 video track）；`caffeinate -us` 包住跑即可。另有一例偶发「面板有文本但步骤为空」（数据通道日志证明桌面端发了带步骤的终帧），未能稳定复现，脚本已加 `TASK_PANEL_HTML` 失败转储便于下次定位。

## 6. 当前真实的未完成清单

| 事项                                                      | 性质                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制面下发 run 到受控端（`ola-task-v1`）                  | 最大的功能缺口：网页端目前只能「看进度 + 远程键鼠」，不能发起任务                                                                                 |
| agent-desktop 验收 7/22 未关                              | 全部是平台/发布项：Windows UIA 套件、Windows 文本输入与孪生 ref、Linux X11/Wayland、Developer ID 签名公证的 dmg、Windows 产物包含性——需要对应机器 |
| `dist/mac-arm64/Electron.app` 仍旧包                      | 需要 `npm run build:mac:staged` 重打包                                                                                                            |
| `access-mode.ts` 与 `authorization-state.ts` 双份模式状态 | 靠调用点同步，无结构保证；宜收敛为单一权威                                                                                                        |
| 其它 14 种语言缺 `workspaceTabs`/`profile` 顶层分组       | 回退英文，i18n 审计通过                                                                                                                           |
| 8 家通讯平台、MCP 实连、Cron 真触发等                     | 上轮记录的未覆盖项，维持                                                                                                                          |

---

# 第四轮：任务同步与画面解耦（同日四续）

需求校准：操作员要的不是 ToDesk 式的「看屏幕、控鼠标」，而是**同步终端在跑什么任务、进度如何、在哪个目录跑**。画面远控保留为可选能力，任务进度成为不依赖画面的一等通路。

## 1. 控制面任务订阅（新增，无需任何会话）

桌面端把任务投影 POST 到控制面，控制台 GET 轮询即可看到——不需要信令、WebRTC、输入通道，也不需要画面许可：

- `POST /api/devices/{id}/task`（设备或账号令牌）：上报一帧快照，字段与 `RemoteTaskSnapshot` 对齐，服务端逐字段封顶（标题 512B、正文 8KB、步骤 60 条、输出 2.4KB）并拒绝未知字段。
- `GET /api/devices/{id}/task`：返回 `{ task, recent[], stale, online }`。`recent` 是最近 12 个已结束任务的简表（runId、标题、状态、目录、步数）——这就是「任务目录」；`stale` 在任务未结束且超过 90 秒没有新帧时为真。
- 投影只保留最新一帧 + 有界历史，内存不随运行时长增长；删除设备时连同清除。

## 2. 快照携带工作目录

- 会话声明了工作目录 → 直接随 `beginRemoteTaskRun` 带上；
- 会话没声明 → 从工具参数里的 `cwd`/`workingDirectory` **采纳**第一次出现的值（`Bash`/`Read` 这类工具自己知道在哪儿跑），后续保持不变；
- 都没有 → 面板如实显示「未指定工作目录」。

## 3. 桌面端上报通路（`remote-task-feed.ts`）

- 订阅投影的第二个 sink（第一个仍是 WebRTC DataChannel）；1.5s 合并，终态帧绕过节流立即发送；发送中的新帧排队不丢弃。
- **许可门**：仅当已登录、已注册设备且 `remoteAccessMode !== 'none'` 时上报——「已关闭」意味着这台机器不该被控制台观测到，工作目录恰恰是最不该泄漏的上下文。
- 新账号操作 `device-task-publish`（8s 超时），失败静默：丢帧只是画面旧一点，绝不是任务失败。

## 4. 控制台

- 设备行新增「**任务进度**」按钮（与「连接画面」并列）：点了只开任务面板，不建立任何会话；连接画面时也会顺带指向同一设备的 feed。
- 面板新增：工作目录行（monospace、中间省略）、步骤参数 monospace、步骤输出、`stale` 黄色警示、「最近任务」列表。
- 会话内 DataChannel 快照与轮询快照按 `updatedAt` 新者胜合并：有会话时即时，没会话时 2s 轮询兜底。

## 5. 验收

端到端（真实 Electron + 真实 Chrome）：**20/20**，新增 3 项：

```
PASS  control plane holds the task projection without a session   completed
PASS  task feed names the directory the work ran in               …/projects/新建项目
PASS  task feed keeps the tool steps                              1 steps
```

专项脚本 `.diag-task-only.mjs` 证明「只看任务、不开画面」：面板完整渲染（标题/目录/步骤/结果文本），页面上 **0 个 `<video>`**。

单测：任务投影 23 项 + 上报模块 5 项（禁用不上报、1.5s 合并、终态直发、换目标丢队列）+ 三态许可 6 项；Go 侧 `device_tasks_test.go` 5 项（空态、目录与步骤、历史归档、坏载荷拒绝、越权 404、删设备清 feed）。`go test ./...`、typecheck、eslint 全绿。

## 6. 语义边界（重要）

- **任务进度可见 ≠ 允许控制**：feed 的读写都只校验设备归属，不要求远控许可非 none——但桌面端在 none 时根本不上报。想看进度，把许可开到「有人值守」即可；不放心键鼠就别开「无人值守」。
- 画面远控保留原状，变为显式动作「连接画面」；不点就什么都不会采集。
