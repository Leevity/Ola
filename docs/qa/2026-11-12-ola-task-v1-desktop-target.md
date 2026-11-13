# 2026-11-12 ola-task-v1：桌面成为 mesh 任务目标（Phase 3）

承接 `2026-11-12-perf-baseline.md` 与 `2026-11-12-interaction-and-ui.md`。
**服务端早已就绪，本轮只改桌面侧**，没有新增协议，只是打通已有协议的反方向。

## 缺口在哪

| 已就绪                                 | 证据                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| 服务端接受 `task.requested`            | `Ola-admin/server/internal/httpapi/mesh.go:418` `validMeshEventType` |
| `task_text` ≤ 12 KiB                   | 同文件 `:446`                                                        |
| `task.execute` capability 已开放       | 同文件 `meshStatusCapabilities`                                      |
| 桌面节点平台可以是 macos/windows/linux | 同文件 `validMeshPlatform`                                           |
| 桌面**向手机**派任务                   | `src/renderer/src/stores/remote-account-store.ts` 的派任务交互       |

缺的 100% 在"桌面作为任务目标"这一侧：`mesh-node.ts` 只广告 `mesh.event.receive`
（注释写着 task execution remains mobile-only），`mesh-events.ts` 拒绝 `task.requested`、
拒绝非移动端来源、payload 白名单里没有 `task_text`。

## 3.1 / 3.2 协议与能力

- `MeshTaskEvent.type` 加 `task.requested`；`TASK_RECEIPT_TYPES` 同步。
- payload 白名单加 `task_text`，上限 12 KiB，与服务端逐字对齐。
- 来源平台分支放开到**任意已注册节点**（手机或另一台桌面都能派）；
  **回执路径仍保持 mobile-only**，两条路径的放宽程度不同。
- 新增 `verifyMeshTaskDispatch()`，要求票里含 `task.execute`；
  与 `verifyMeshTaskReceiptDelivery()` 并列，**不共用放宽后的校验**。
- `mesh-node.ts` 广告 `{ id: 'task.execute', risk: 'high', version: '1' }`，删掉 mobile-only 注释。

Ed25519 签名与 canonical-JSON 校验一行未削弱。

## 3.3 授权与落地：六个必须解释的设计决定

**1. Main 是唯一权威。** 只有 `recordVerifiedMeshTask` 能写入 inbox，而它唯一的调用者
（`account-client.ts` 的 `mesh-event-list` 循环）已经验签 + 验 `task.execute` 票。
渲染层因此只能"对 Main 认证过的任务做决定"，**永远不能凭空造一个任务**。
`mesh-event-list` 的返回形状逐字节不变，`MobileMeshWorkspace.tsx` 无需改动。

**2. admission ≠ execution。** `admitted` 只表示访问模式与配额放行了它；
渲染层还必须 claim（`remote:task:started`），Main 对第二次 claim 返回失败。
这是"两个窗口不会同时跑同一个请求"的唯一保证。

**3. `session-busy` 而不是抢占。** `beginRemoteSession(otherId)` 会清空 `runSessions`，
等于静默撤销本地用户正在依赖的审批。所以活跃会话属于别人时**拒绝任务**，
而不是替换会话。门禁里有一条断言专门检查第一个会话在拒绝后仍然存活。

**4. 任务与输入是两条独立授权路径。** `admitRemoteTask` 不碰 `setAuthorizedInputSession`；
attended 准入之后 `requestAutoApproval` 仍返回 `not-unattended`，
`isInputSessionAuthorized` 仍为 false。互相都不放行。

**5. unattended 自动准入消耗同一份配额**（200 次 / 12h，与工具审批共用）。
自动准入失败时记为 `rejected` 并发回执——对端得到答复，而不是沉默。
（第一版留在 `pending`，而 record 对已存在的 id 直接返回旧条目，等于永远不再重试。）

**6. 撤销远程访问会一并撤销 inbox。** `pending` / `admitted` 一律 `expired` 并发回执；
已经 `running` 的那时已是本地工作，不动它，它的自动审批随会话一起停。

## 3.4 回执与 UI

- **注入式 publisher**（沿用 `remote-task-progress.ts` 的范式）：`task-dispatch.ts` 不依赖网络，
  由 `remote-handlers.ts` 注册 `setMeshTaskReceiptPublisher`，避免与 account-client 成环。
- 回执走 `mesh.event.receive`，**不是** `task.execute`：跑任务与报告任务是两种能力，
  派发票不能当回执照用。
- `use-remote-mesh-tasks.ts` 每 5s 轮询 `loadMeshTaskEvents` 喂 Main 的 inbox。
  **agent loop 用 dynamic import**：`Layout.tsx` 静态引 `RemoteControlHost`，
  静态引 `sendChatMessage` 会把整条聊天管线拉进首屏并触发 Phase 1.7 的预算门禁。
- `createSession` 会无条件激活新会话，所以先记 `previousActive` 再恢复——
  远程任务不该移动本地用户正在看的视图。
- `runId` 从 `runtime-projection-store` 订阅取（`ts-runtime-bridge.ts` 已有的
  `bindRunToRemoteSession` 会绑定每个提交的 run），结果文本用 `currentRemoteTaskSnapshot()`
  且 **runId 必须匹配**才采用。
- `RESULT_TEXT_CHARS = 3000`：3000 × 4 字节 = 12000 ≤ 12288。
  projection 自己的上限是 4000 字符，4 字节码点下会撑破 Main 的 12 KiB 校验。
- `RemoteMeshTaskInbox.tsx` 挂在 `Layout`，**不是** `RemoteControlHost` 内部——
  后者在 snapshot 取回 null 时会卸载。16 语言；插值用 `{{running}}` 而不是 `{{count}}`，
  否则 i18next 会去找复数形式键。

## 验证

| 门禁                                  | 结果                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `typecheck:node` / `typecheck:web`    | 绿，0 error                                                                       |
| `test:runtime`                        | **333 files / 1667 tests 全过，20.99s**（基线 60–70s）                            |
| `verify:remote-authorization`         | 绿                                                                                |
| `verify:remote-workspace-theme`       | 绿（新增 6 个 `meshTask*` 键 + 7 个拒绝原因）                                     |
| `lint` / `prettier`                   | 绿                                                                                |
| `build` + renderer 预算门禁           | 绿：首屏闭包 **4,183,954 字节 / 6 chunks**（Phase 1 收尾 4,178,329 → **+5,625**） |
| 真机 e2e（本地 Ola-admin dev server） | **47/47**，其中新增 16 项 mesh 检查                                               |

新增行为测试：`tests/runtime/remote-task-dispatch.test.ts`（9 例，含两种票的交叉重放）、
`desktop-mesh-capabilities.test.ts`（2 例）。

### 真机 e2e 怎么跑的

```bash
OLA_REMOTE_DEV_MODE=1 npm --prefix ../Ola-admin run server:dev   # 内存态，无需 Postgres/Redis
node docs/qa/remote-access-e2e.mjs                               # 47/47
```

探针新增第 6 节：手机节点（ios，只有 `mesh.event.receive`）向桌面节点（macos，含 `task.execute`）
派 `task.requested`，桌面收下载荷完整的任务文本，再用回执能力把 `task.completed` 发回去。
同时验证：不广告 `task.execute` 的节点不能被该能力指向（403）、空 task_text（400）、
13 KiB task_text（400）、签名后改载荷（403）、复用 eventId 改载荷（409）、
列 inbox 必须带该设备 token（403）。

**一个必须记下来的边界**：服务端只把票绑定到 account/subject/target/session，
**不按事件类型校验能力**——用 `mesh.event.receive` 的票发 `task.requested`，服务端返回 202。
所以"回执不能当派发用"这条 invariant **完全由桌面验证器承担**
（`remote-task-dispatch.test.ts` 两个方向都覆盖了）。探针里有一项检查专门钉住服务端这个行为，
将来服务端若收紧，这条会显式变化而不是悄悄漂移。

### 反向验证（11 项，语义破坏必红）

| 破坏                                            | 门禁                 |
| ----------------------------------------------- | -------------------- |
| 删掉 zh 的 `remote.meshTaskReason.session-busy` | theme **RED**        |
| inbox 里加 `defaultValue` 内联兜底              | theme **RED**        |
| 桌面不再广告 `task.execute`                     | auth **RED**         |
| dispatch 不再写入 Main inbox                    | auth **RED**         |
| attended 准入不再需要确认                       | auth **RED**（见下） |
| 投递在任何模式下都自动准入                      | auth **RED**         |
| accept 按钮不再算作确认                         | auth **RED**         |
| 第二个窗口可以重复 claim                        | auth **RED**         |
| 别的 peer 可以抢占活跃会话                      | auth **RED**         |
| 任务准入顺带授权远程输入                        | auth **RED**         |

全部破坏后恢复，两个门禁重新变绿。

**第一条 attended 破坏最初是 GREEN**，值得记：`admitRemoteTask` 的确认守卫当时**不可达**——
两个调用点都传对了 flag，所以删掉守卫没有任何可观测行为变化。
补了"直接调用 `admitRemoteTask(sessionId, false)` 必须返回 `confirmation-required`"
与"attended 下投递后条目仍是 `pending`"两条断言之后才变红。
**不可达的守卫等于没有被门禁保护**，这类纵深防御要直接断言，不能只靠端到端路径。

## 顺手修的三处门禁 / 探针问题

1. **`verify:remote-authorization` 的 runner 换成 esbuild。**
   `access-mode.ts` 用了无扩展名相对 import，`node --experimental-strip-types` 解析不了
   （`ERR_MODULE_NOT_FOUND`）。沿用同目录 `verify:remote-store` 的 esbuild 范式。
2. **e2e 探针的 audit 断言过期。** 探针在撤销前先切回 `attended`，
   所以 `unattended → none` 这个转换从不发生，断言却要求它。
   改为断言实际发生的三个转换（none→attended、attended→unattended、attended→none）。
   这是探针的期望陈旧，不是产品回归。
3. **`verify:hooks` 在本机根本跑不起来。** Homebrew 的 Node 是 shared-libnode 构建，
   把 `node` 二进制复制/硬链到临时目录后 `@rpath/libnode.141.dylib` 找不到，
   hook 进程起不来 → `status: canceled`、`output: {}`。
   loader 要求命令必须在 config 目录内（`escapes its config directory`），
   所以不能直接用 `process.execPath`。POSIX 改用 `#!/bin/sh` + `exec` 包装，
   Windows 保留复制分支（那里 `#!/bin/sh` 不可 spawn，EFTYPE）。修完 `hooks framework verification passed`。

## 未覆盖的部分

- **没有真实手机 → 桌面的完整 UI 走查。** e2e 验证的是服务端中继与签名/能力边界；
  桌面侧准入状态机由 `verify:remote-authorization` 与 `remote-task-dispatch.test.ts` 覆盖。
  "手机点派发 → 桌面弹确认 → 跑完回执"这条链路**没有实机截图**。
- **一次只允许一个任务。** 活跃会话被占用时后来者拿 `session-busy`，没有排队。
- **5s 轮询不是推送。** Main 侧没有定时器，inbox 靠渲染层轮询喂；
  窗口关掉（应用留在托盘）时新任务不会被记录。回执发送本身在 Main，不依赖窗口。
- **pending TTL 10 分钟 / MAX_TASKS 64 是本地常量**，未与服务端票的 5 分钟 TTL 对齐；
  票过期是 replay 的外层边界，本地常量只防长命进程无限增长。
- coturn 的 TURNS 443 属 Ola-admin 部署配置，本轮未改其代码。
