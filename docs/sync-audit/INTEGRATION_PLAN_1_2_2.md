# Ola × 1.2.2 能力融合计划

> 状态：阶段 0–4 与 Hooks 主链路已落地；当前续做点是「子 Agent 历史 + 精确取消」。
> Ola 基线 HEAD（工作区）：以本地 `git` 为准；此前叙述基线 `d5f6bfb`，后续已有 hooks / drafts / retry 等提交。
> 参考指纹锁定：`docs/sync-audit/baseline.json`（`18413c22` / 1.2.2）。
> 目标：按垂直切片吸收成熟能力，不覆盖 Ola 产品身份、凭据体系、多宠物模型、远控工作台和 Windows 开发稳定性。

## 0. 完成度快照（以代码现状为准）

| 顺序 | 分支建议 | 内容 | 状态 | 证据 / 备注 |
| ---: | --- | --- | --- | --- |
| 0 | `codex/sync-audit-1-2-2` | 审计工具 + baseline | ✅ 完成 | `docs/sync-audit/*`、`scripts/audit-opencowork-sync.mjs` |
| 1 | `codex/permission-policy` | 权限策略 | ✅ 完成 | `docs/sync-audit/PHASE_1_PERMISSION_POLICY.md` |
| 2 | `codex/provider-retry` | 重试与压缩设置 | ✅ 完成 | `AgentRuntimeProviderRetryPolicy.cs` |
| 3 | `codex/input-drafts` | 输入草稿 | ✅ 完成 | 跨会话草稿持久化已存在 |
| 4 | `codex/content-blocks` | 内容块 | ✅ 完成 | 用户确认：自动验证 + 生产构建 + 桌面验收通过 |
| 5 | `codex/hooks-runtime` | Hooks 核心 | ✅ 基本完成 | `src/main/hooks/*`、`src/main/ipc/hooks-handlers.ts`、sidecar 触发点 |
| 6 | `codex/hooks-ui` | Hooks 管理 UI | ✅ 基本完成 | `HooksPanel.tsx`、`hooks-store.ts`、settings 入口 |
| 7 | `codex/subagent-history-cancel` | 子 Agent 历史 + 精确取消 | 🟡 进行中 | **当前续做主线** |
| 8+ | `codex/ssh-*` / `codegraph-*` / … | 后续能力 | ⬜ 未开始 | 本轮不跨阶段 |

### 阶段 7 当前进度（本轮起点）

**已完成（Native Worker，工作区未提交）：**

- `sidecars/Ola.Native.Worker/Modules/Db/DbSubAgentHistoryTools.cs`（新）
- `sidecars/Ola.Native.Worker/Modules/Db/DbSchemaMigrator.cs`（`sub_agent_history` + `app_migrations`）
- `sidecars/Ola.Native.Worker/Modules/Db/DbModule.cs`（6 条 route 注册）
- `sidecars/Ola.Native.Worker/Serialization/WorkerJsonContext.cs`（序列化上下文）

**已注册 Worker 路由：**

| Route | 用途 |
| --- | --- |
| `db/sub-agent-history-index` | session 轻量索引（无 snapshot） |
| `db/sub-agent-history-list` | 分页列表（含 snapshot / hasMore） |
| `db/sub-agent-history-apply` | 单条 upsert（`session_id + tool_use_id`） |
| `db/sub-agent-history-replace` | 整批替换 |
| `db/sub-agent-history-migration-status` | 迁移状态 |
| `db/sub-agent-history-migration-mark` | 幂等标记迁移 |

**未完成：**

1. Main DAO + IPC + shared 类型 + preload/channels
2. Renderer：从 `ola-agent-history`（ipcStorage）一次性迁移到 SQLite
3. 流式增量写入（`sub_agent_start` / progress / `sub_agent_end`）
4. 单个子 Agent 精确取消（当前仅父 run 取消会连带子 run）
5. UI 取消入口 + 重启后历史恢复
6. 自动验证脚本与桌面烟测

### 旧路径（必须迁移，不可丢）

Renderer 现状：

- 存储键：`ola-agent-history`（`AGENT_HISTORY_STORAGE_KEY`）
- 状态：`sessionSubAgentSummaries` / `subAgentHistory`
- 文件：`src/renderer/src/stores/agent-store.ts`
- UI：`SubAgentsPanel.tsx`、`SubAgentCard.tsx`、`SubAgentExecutionDetail.tsx`

取消现状：

- Renderer：`agentBridge.cancelAgent(runId)` → `agent:cancel`
- Main：`sidecar-manager` → Worker `agent/cancel`
- Worker：`AgentRuntimeTools.Cancel` 只按 **父 runId** 取消
- 子 Agent：`AgentRuntimeSubAgentExecutor` 通过 `parentState.CancellationToken.Register` 连带取消，**无 toolUseId 级取消**

---

## 1. 执行原则

1. 不进行仓库级合并或目录级复制。每项能力按“契约 → 主进程/Worker → Renderer → 持久化 → UX → 验证”垂直集成。
2. 每个阶段从最新可合入基线创建独立分支，完成后单独合并；禁止把 CodeGraph、Hooks、SSH 重构等高风险项目塞进同一个 PR。
3. Ola 现有能力优先：`~/.ola`、`OLA_*`、`Ola.Native.Worker`、本地凭据库、多宠物、远控、`launch-dev.mjs` 和已有验证脚本不得回退。
4. 新能力默认关闭或按需加载。高风险能力必须显式启用。
5. 每个 PR 必须能独立回滚。数据库只允许增量字段/表；协议只增版本或可选字段。
6. 同步审计只提供证据，不作为自动复制清单。
7. **PR 卫生**：title/body/commit 不得出现参考产品名、参考仓库路径、参考提交哈希；内部 dev doc 可保留审计字段。

## 2. 当前差异概览

基于 `scripts/audit-opencowork-sync.mjs` 最近一次摘要（`docs/sync-audit/SUMMARY.md`）：

| 分类 | 数量 | 含义 |
| --- | ---: | --- |
| identical | 434 | 实现相同，无需处理 |
| brandOnly | 26 | 仅品牌差异，保持 Ola 命名 |
| changed | 314 | 同路径但行为已分叉，需要逐项审查 |
| onlyOla | 88 | Ola 独有，默认保留 |
| onlyReference | 391 | 参考独有候选（大量属 CodeGraph） |

## 3. 融合优先级与用户效果

| 优先级 | 能力 | 状态 | 预期用户效果 |
| --- | --- | --- | --- |
| P0 | 权限策略 | ✅ | 可配置工具白名单 / 命令规则 |
| P0 | Provider 重试与压缩状态 | ✅ | 429/5xx 自动重试并显示等待 |
| P0 | 输入草稿 | ✅ | 切换会话后输入不丢 |
| P1 | Hooks | ✅ 主链路 | 可信脚本挂接事件前后 |
| P1 | 子 Agent 历史与取消 | 🟡 | 重启可回看；可取消单个子 Agent |
| P1 | SSH Store 模块化 | ⬜ | 远控状态更稳 |
| P1 | 浏览器 Cookie 导入 | ⬜ | 授权后导入登录态到 Ola Vault |
| P2 | CodeGraph | ⬜ | 项目索引与结构化检索 |
| P2 | AI Coding Terminal | ⬜ | 远控标签内托管 coding CLI |
| P3 | Draw Graph / 视频 / 发布增强 | ⬜ | 非核心，最后评估 |

## 4. 明确保留且不接受覆盖的 Ola 能力

- 保留 `Ola` 应用 ID、协议、窗口标题、安装包名、`~/.ola`、`OLA_*`
- `src/main/credentials/secret-vault.ts` 是秘密存储权威
- `pets-store` 多宠物真源；不允许退化为单宠物
- 统一远控工作台是唯一远控入口
- 保留 `scripts/launch-dev.mjs` Windows 兼容与既有 verify 脚本

## 5–9. 阶段 0–4（已完成）

详见历史提交与 `docs/sync-audit/PHASE_1_PERMISSION_POLICY.md`。不再重开。

完成定义回顾：代码/协议/持久化/UI 闭环、中英文案、安全默认值、自动验证、烟测无回归、独立 Conventional Commit、可独立回滚。

## 10. 阶段 5–6：Hooks（已基本完成）

落地证据：

- Main：`hooks-service.ts` / `hooks-loader.ts` / `hooks-runner.ts` / `hooks-handlers.ts`
- Shared：`src/shared/hooks/types.ts`
- Renderer：`HooksPanel.tsx`、`hooks-store.ts`
- 触发：`sidecar-manager.ts` 已 import `hooksService`
- 清理：过期 run history 周期 prune 已有提交

本轮**不回头重做 Hooks**，除非子 Agent 工作发现硬依赖缺口。

## 11. 阶段 7：子 Agent 历史与精确取消（当前执行）

### 11.1 目标

1. 子 Agent 运行记录写入 SQLite，重启后可按 session 回看
2. 旧 `ola-agent-history` 一次性迁移，幂等
3. 运行中增量 upsert，结束时写最终 snapshot
4. 支持按 `toolUseId` 取消**单个**子 Agent，不影响父 run 及其他子 Agent
5. UI 能触发取消，并正确展示 `running/completed/failed/cancelled`

### 11.2 架构

```
Renderer agent-store / SubAgentsPanel
  ├─ 读历史：IPC → Main DAO → Worker db/sub-agent-history-*
  ├─ 写历史：事件流 handleSubAgentEvent → apply（debounce）
  └─ 取消：agentBridge.cancelSubAgent({ parentRunId, toolUseId })
        → Main agent:cancel-sub-agent
        → Worker agent/cancel 扩展参数 toolUseId
        → parentState 内 child CTS map 精确 Cancel
```

### 11.3 实施切片（建议 4 个可回滚 commit，同一分支）

#### Slice A — 固化 Worker 基座并补 Main 契约

**文件：**

- 已有 Worker 4 文件（提交）
- 新增 `src/main/db/sub-agent-history-dao.ts`（仿 `agent-changes-dao.ts`）
- 扩展 `src/main/ipc/db-handlers.ts` 或独立 `sub-agent-history-handlers.ts`
- `src/shared/messagepack/binary-ipc.ts` 通道常量
- `src/renderer/src/lib/ipc/channels.ts` / preload 暴露（若项目对 db 通道有白名单）

**验收：**

- Renderer 能 `index/list/apply/replace/migration-*`
- Worker 编译 0 错 0 警

#### Slice B — 旧历史迁移 + 会话加载

**文件：**

- `src/renderer/src/stores/agent-store.ts`
- 可选 `src/renderer/src/lib/agent/sub-agent-history-migration.ts`

**行为：**

1. 启动或首次打开 session 时读 `migration-status(key=sub_agent_history.bootstrap.v1)`
2. 未迁移：读 `ola-agent-history` → 规范化 → `replace` 按 session 写入 → `mark`
3. 之后 session 切换优先从 SQLite `index/list` hydrate `sessionSubAgentSummaries`
4. 迁移成功后可停止把完整历史当作长期唯一真源写回 ipcStorage（可保留短缓存）

**验收：**

- 老用户升级后历史不丢
- 重复启动 migration key 只出现一次
- 删除 session 时 SQLite 级联清理（FK ON DELETE CASCADE）

#### Slice C — 流式增量写入

**文件：**

- `agent-store.ts` 的 `handleSubAgentEvent`
- 可选 Main 侧不经 Renderer 的直写（默认先走 Renderer，简单且已有事件）

**行为：**

| 事件 | status | snapshot |
| --- | --- | --- |
| `sub_agent_queued` / `start` | `running` | 轻量摘要 |
| progress / tool / report | `running` | 节流更新（≥500ms） |
| `sub_agent_end` success | `completed` | 最终摘要 |
| end error | `failed` | error + 摘要 |
| 用户取消 | `cancelled` | 取消时摘要 |

唯一键：`(sessionId, toolUseId)`。`subAgentId` 可用 `subagent-{toolUseId}-...` 或 name+id 稳定值。

**验收：**

- 运行中杀进程 / 重启，至少能看到 running→最终态之一
- 高频事件不把 DB 打爆（debounce）

#### Slice D — 精确取消

**Worker：**

- `AgentRuntimeRunState` 增加 `ConcurrentDictionary<toolUseId, childState/CTS>`
- `ExecuteTaskAsync` / background 路径注册与 finally 移除
- `AgentRuntimeTools.Cancel` 扩展：
  - 仅 `runId`：保持现网语义（取消整 run）
  - `runId + toolUseId`：只取消对应 child
- 取消后仍发 `sub_agent_end`（result 标记 cancelled），便于 UI/历史闭环

**TS 链路：**

- `agent-bridge.cancelSubAgent({ runId, toolUseId })`
- Main `agent:cancel` 透传可选 `toolUseId`（兼容旧调用）
- `SubAgentsPanel` / `SubAgentCard` 运行中显示取消按钮

**验收：**

- 并行 2 个子 Agent，取消 A，B 继续
- 取消父 run 仍取消全部子
- 历史 status=`cancelled`

### 11.4 建议提交（不含参考产品字样）

```
feat(db): add sub-agent history schema and worker routes
feat(db): expose sub-agent history ipc and dao
feat(agent): migrate renderer sub-agent history to sqlite
feat(agent): stream sub-agent history upserts
feat(agent): support cancelling a single sub-agent
```

### 11.5 验证

自动：

```bash
npm run typecheck
npm run lint
# Worker
dotnet build sidecars/Ola.Native.Worker/Ola.Native.Worker.csproj
# 若补脚本
node scripts/verify-sub-agent-history.mjs   # 可新增
```

人工烟测：

1. 中/英启动
2. 触发至少 2 个并行 Task 子 Agent
3. 取消其中一个，另一个完成
4. 重启应用，历史仍在
5. 旧 `ola-agent-history` 数据迁移一次成功
6. 删除 session 后历史消失
7. 普通聊天取消整 run 行为不变

### 11.6 明确不做

- 不把 Hooks / CodeGraph / SSH 重构混进本分支
- 不在 PR 描述写参考来源
- 不删除现有 Renderer 内存态（active/completed）只替换其持久化后端
- 不做跨设备同步 sub-agent history（除非已有通用 sync 钩子且无额外风险）

## 12. 阶段 8+（暂缓，仅占位）

顺序保持原计划：

1. SSH store slices → SSH workspaces
2. Browser cookie import（依赖权限策略，写入 Ola Vault）
3. CodeGraph assets → index → agent tools → UI
4. AI Coding terminal
5. distribution/update；Media/Draw graph 默认 defer

## 13. 跨阶段测试与门禁

每个 PR 至少：

```bash
npm run typecheck
npm run lint
npm run build
```

涉及既有安全/远控时追加对应 `verify:*`。涉及 Worker 时追加 `dotnet build/publish`。

## 14. 分支策略（续做时）

1. 确认当前分支 `codex/subagent-history-cancel` 相对可合入基线的 rebase/merge 状态
2. **本轮只做阶段 7**，不切去 SSH/CodeGraph
3. Worker 未提交改动先纳入 Slice A 提交，避免丢失
4. 合并后回到最新 main，再开下一阶段分支

## 15. 完成定义（每个切片）

1. 契约→实现→UI/调用方闭环，无 mock 冒充完成
2. 中英文案齐全，其他语言英文 fallback
3. 安全默认值；迁移幂等
4. 失败路径有覆盖（缺 sessionId、重复 migration、取消已结束子 Agent）
5. 远控/凭据/多宠物/聊天无回归
6. 独立 Conventional Commit，工作区干净，可回滚
7. PR 文案零参考产品泄露
