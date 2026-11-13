# 辅助模型请求的会话绑定修复（2026-11-12）

## 缺陷

渲染进程提交的每一个"辅助"模型请求都带着一个**合成会话 ID**，而 Main 在
`src/main/ipc/ts-runtime-handlers.ts:857` 用 `getSession(run.sessionId, run.workspaceId)`
校验运行归属，查不到就抛 `SESSION_WORKSPACE_MISMATCH`。结果是：请求在到达模型之前就被拒绝，
所有辅助文本功能静默失效。

发现路径：`npm run verify:electron-startup` 失败，渲染进程日志里两条
`[TS Runtime] auxiliary text request failed Error: SESSION_WORKSPACE_MISMATCH`。
这不是本轮改动引入的，是既有缺陷。

受影响的提交点（全部在渲染进程）：

| 文件                                             | 原合成 ID                     | 功能                                   |
| ------------------------------------------------ | ----------------------------- | -------------------------------------- |
| `lib/ipc/agent-bridge.ts` `runTsTextRequest`     | `auxiliary-text:<uuid>`       | 8 个调用方的公共入口                   |
| `lib/ipc/agent-bridge.ts` `streamTsProviderTurn` | `ts-provider:<uuid>`          | 翻译 / 提示词优化 / 技能审查的公共入口 |
| `lib/prompt-optimizer/optimizer.ts:158`          | `prompt-optimizer:<nanoid>`   | 提示词优化                             |
| `lib/translate-service.ts:103`                   | `translate:<nanoid>`          | 翻译                                   |
| `lib/translate-agent-service.ts:190`             | `translate-agent:<nanoid>`    | 代理式翻译                             |
| `lib/api/auto-model-selector.ts:960`             | `auto-model-routing:<uuid>`   | 自动模型路由                           |
| `lib/pet/pet-agent.ts:190`                       | `pet:<petId>`                 | 桌宠对话                               |
| `lib/agent/skill-reviewer.ts:61`                 | `skill-review:<nanoid>`       | 技能安全审查                           |
| `lib/agent/memory-automation.ts:581/908`         | 继承 provider（无 sessionId） | 记忆自动化一/二阶段                    |

`runTsTextRequest` 的 8 个调用方：标题生成、提交信息生成、提示词推荐、绘图提示词优化、
桌宠宣言优化、会话重命名（侧栏与会话列表）、记忆自动化两阶段。

## 修复

新增单一收敛点 `src/renderer/src/lib/ipc/auxiliary-run-session.ts`：

```
resolveAuxiliaryRunSessionId(workspaceId, preferred)
  1. preferred 非空 → 直接用（调用方自己拥有的会话，最准确）
  2. 否则取该 workspace 内的活动会话
  3. 否则取该 workspace 内 updatedAt 最新的会话
  4. 都没有 → null，调用方显式抛 TS_RUNTIME_TEXT_SESSION_REQUIRED
```

**绝不跨 workspace 借用会话**，绝不生成合成 ID。chat store 用动态 import 引入，
避免与运行时 bridge 形成静态循环。

Main 的授权校验**一行未改**。Main 自有自动化（Cron）仍直接走
`desktopRuntime.request('run.submit')`，不经过渲染进程的会话校验，行为不变。

显式传入真实会话的调用方（比回退更准确）：

- `lib/api/generate-title.ts` 新增 `options.sessionId`
- `lib/agent/chat-send-message.ts:770` 传 `capturedSessionId`
- `components/layout/WorkspaceSidebar.tsx:1024` 传 `sessionId`
- `components/layout/SessionListPanel.tsx:829` 把 `sessionId` 加进 provider
- `memory-automation.ts` 一阶段传 `args.sessionId`；二阶段新增 `runSessionId`
  形参，与记录用的 `sourceSessionId` 分开——**每日 rollup 的记录键是
  `rollup:<date>`，那是合成 ID，不能拿去做运行授权**，所以 rollup 走回退。

失败语义按各文件既有约定：`runTsTextRequest` / 翻译 / 路由 / 桌宠 / 技能审查抛显式错误
（技能审查的调用方 `stores/skills-store.ts:404` 有 try/catch）；
`streamTsProviderTurn` 产出 `error` 事件；提示词优化沿用自身的空结果分支并打印错误码。

## 验证

| 项                                                         | 结果                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run typecheck`                                        | EXIT 0                                                             |
| `npm run lint:ci`                                          | EXIT 0                                                             |
| `npm run format:check`                                     | EXIT 0                                                             |
| `npm run test:runtime`                                     | 334 文件 / 1674 测试通过，7 文件 10 测试跳过，20.53s               |
| 新增 `tests/runtime/auxiliary-run-session-binding.test.ts` | 7/7                                                                |
| `npm run build`                                            | EXIT 0                                                             |
| `npm run verify:electron-startup`                          | **passed: true**，`translateFlowChecked: true`，23 路由 / 6 功能面 |
| `npm run verify:renderer-bundle`                           | 4,185,151 字节 / 6 chunk（Phase 3 后为 4,183,954，+1,197）         |

修复前同一门禁：`STARTUP_EXIT:1`，两条 `SESSION_WORKSPACE_MISMATCH`。

### 反向验证

| 临时破坏                                                     | 期望       | 实测                                                              |
| ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------- |
| 把 `runTsTextRequest` 的解析结果换回 `auxiliary-text:<uuid>` | 新测试变红 | **3 条红**（自有会话、活动会话回退、跨 workspace 拒绝），4 条仍绿 |
| 恢复修复                                                     | 全绿       | 7/7                                                               |

## 两个过程教训

1. **`verify:electron-startup` 不构建**。它直接跑 `out/`。第一次重跑门禁仍报同样的错，
   是因为 `out/renderer/assets` 还是 20:48 的旧产物（chunk hash 与修复前完全一致）。
   必须先 `npm run build` 再跑门禁，否则读到的是上一个二进制的错误。
2. 断言要用 `toMatchObject` 而不是 `toEqual`：真实调用方会带 `modelOptions`/`history`/
   `prompt` 等字段，全量相等断言会把"绑定正确"误判成失败。

## 未覆盖

- **没有真实模型往返**。门禁环境没有可用 API key，证明的是"提交被授权、不再被
  `SESSION_WORKSPACE_MISMATCH` 拒绝"，不是"供应商返回了文本"。标题/提交信息/翻译的
  端到端产出仍需在有 key 的环境手工冒烟。
- **回退会把辅助运行挂到该 workspace 最新的会话上**。这与仓库既有的
  `context-compression.ts:337`、`final-outcome.ts:261` 做法一致：辅助运行不写业务消息表，
  因此不会污染 transcript；`beginRuntimeSessionSubmission`
  （`ts-runtime-handlers.ts:255`）只是**删除屏障**，不是互斥锁，所以只会短暂推迟该会话的删除。
- **workspace 内一个会话都没有时**（全新安装、还没聊过天），设置页里的桌宠宣言优化、
  绘图提示词优化等会显式失败而不是静默失败。这是有意的 fail-closed，但用户体验上
  需要一个"先创建会话"的提示文案，本轮未加。
- 每日 rollup 依赖回退挑选会话；若该 workspace 无会话，二阶段模型整合会失败并走
  既有 fallback（`memory-automation.ts:998` 已有 warn）。
- 未做多 workspace（ola-personal / ola-team）真机验证：托管 workspace 的会话是否已加载进
  chat store 决定了回退能否命中，未命中时显式拒绝。
