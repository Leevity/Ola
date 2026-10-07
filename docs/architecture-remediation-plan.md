# Ola 架构完善计划（改造后缺口收口）

> 目标分支：`main-ts`
> 基线：HEAD `6c1e13b`（typed IPC contract + hardened runtime security 已合入），工作区干净。
> 依据：针对改造后快照的代码级架构分析。本计划只描述 Ola 自身改造，提交信息不含任何外部项目名称。

## 1. 背景

第一批架构改造（IPC 契约、类型化门面、Capability、Store 域拆分）已合入。本计划针对架构分析发现的 5 个关键缺口做收口，并按迁移台账的未完成项推进验收。

## 2. 关键缺口定位（path:line）

| #   | 缺口                     | 证据                                                                                                                                   | 影响                                          |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| G1  | 白名单被 legacy 数组架空 | `shared/ipc/contract.ts:473` + `preload/index.ts:22-27`                                                                                | 严格模式仍放行未登记通道，安全边界失效        |
| G2  | 类型门面约束退化         | `typed-ipc-client.ts:20`（`C extends IPCChannel \| string`）                                                                           | 通道拼写错误编译期不报；Schema 覆盖仅 22/200+ |
| G3  | 双份路径策略漂移         | shared `path-policy.ts` vs `runtime/tools/local-read-file.ts:25-40` 内联 `confinedWorkspacePath`                                       | 共享安全层未进运行时执行链，冗余且易漂移      |
| G4  | 交互读工具直接放行       | `runtime-tool-authorization.ts:44`（`effect==='read'` 直接返回）                                                                       | 前台读能力不经过 Capability 决策              |
| G5  | 死代码 / 命名漂移        | `agent-store-selectors.ts`、`chat-store-selectors.ts` 全量零消费；Schema 键名与字面量不一致；`IpcResult`/`IpcChannelMetadata` 无调用方 | 类型安全形同虚设，维护负担                    |

## 3. 迁移台账完成情况

- **代码级 route：100% 通过**，无 `legacyPathRemoved:false`。
- **发布级未完成**：
  - P1（Electron E2E / 视觉验收）——实现中
  - P10（对话与功能页验收，evidence 空）——实现中
  - P12（删 .NET / 真实主站 / 六平台原生验收）——实现中
  - 六平台 windows/linux/mac × x64/arm64 缺 install/upgrade/launch 证据——外部阻塞
  - `realSite.status = "未开始"`
  - 严格退出门禁 `verify:ts-migration-exit` 按设计预期失败

## 4. 改进项与实施阶段

### S1：收紧 IPC 白名单（对应 G1）—— 安全最高优先

目标：拆除 `legacyRendererChannels` 后门，全部实际通道纳入 `IPC` 字面量，使严格模式真正拒绝未登记通道。

工作项：

1. 扫描 renderer 全部 `ipcClient.invoke/send/on` 字面量调用点，将仍在 `legacyRendererChannels` 但未进 `IPC` 的通道（`pet:*`、`window:*`、`media:*`、`desktop-flow:*` 等）逐一加入 `IPC` 字面量。
2. 删除 `contract.ts:473` 的 `legacyRendererChannels` 数组，`isKnownIpcChannel` 仅保留 `ipcChannelSet.has(channel)`。
3. 新增一致性测试：断言 "renderer 字面量调用点 ⊆ `IPC` 字面量"。

提交：

```text
refactor(ipc): remove legacy channel allowlist backdoor
```

### S2：强化类型门面（对应 G2）—— 安全 + 类型安全

目标：泛型收紧为严格 `C extends IPCChannel`，为高敏通道补齐 Schema。

工作项：

1. `typed-ipc-client.ts:20` 去掉 `| string`，改为严格 `C extends IPCChannel`。
2. 优先为高敏通道（`fs:*`、`shell:*`、`credentials:*`、`browser:*`、`runtime:*`）补齐 `ipcChannelSchema`，修正与真实字面量不一致的键名。
3. 未登记 Schema 的通道在编译期走 `unknown`，但通过 lint 规则或测试禁止新增高敏通道无 Schema。

提交：

```text
feat(ipc): enforce strict channel typing and schema coverage
```

### S3：统一路径策略（对应 G3）—— 一致性

目标：消除双份路径策略，让 runtime 工具复用 shared 实现。

工作项：

1. 新增 `runtime/tools` 对 shared `resolveWorkspacePath` 的复用入口。
2. 将 `local-read-file.ts`、`local-write-file.ts` 等内联 `confinedWorkspacePath` 改为调用 shared 实现，删除内联副本。
3. 保持现有 realpath 语义不变，补充单测覆盖符号链接逃逸。

提交：

```text
refactor(security): unify workspace path policy in runtime tools
```

### S4：覆盖交互运行工具授权（对应 G4）—— 一致性

目标：让 `evaluateToolCapability` 同时覆盖前台交互运行的写/执行工具，而不仅是 Cron/子 Agent。

工作项：

1. 审计 `runtime-tool-authorization.ts` 交互分支（`!run.unattended`）。
2. 让前台写/执行工具也经过 Capability 决策（命令、路径、资源绑定）。
3. 读工具保持只读放行，但记录审计点，避免无边界扩展。

提交：

```text
feat(security): apply capability policy to interactive tool runs
```

### S5：清理死代码与命名漂移（对应 G5）—— 维护

目标：删除零消费 selector，修正 Schema 键名，移除无调用方类型。

工作项：

1. 审计 `agent-store-selectors.ts`、`chat-store-selectors.ts` 是否可删；若需保留，则补真实消费者或删除。
2. 修正 `ipcChannelSchema` 与 `IPC` 字面量不一致的键名。
3. 删除或接线 `IpcResult`、`IpcChannelMetadata`、`IpcTransport` 等无调用方类型。

提交：

```text
chore(architecture): remove dead selectors and align schema keys
```

### S6：推进迁移验收（P1/P10/P12）—— 发布级

目标：补齐发布级验收证据，推进严格退出门禁。

工作项（需要构建/打包/部署环境）：

1. P10：为对话与功能页补验收证据（截图 + E2E）。
2. P12：补六平台 install/upgrade/launch 证据；记录签署 waiver 与 noDotnet 佐证。
3. 真实主站：从"未开始"推进，补充个人/团队目录、工单、撤销等证据。
4. 待上述完成后再跑 `verify:ts-migration-exit`。

提交（对应各验收批次）：

```text
test(migration): add dialog and feature-page acceptance evidence
```

## 5. 实施顺序

按风险与依赖排序：

```text
S1 → S2 → S3 → S4 → S5 → S6
```

S1、S2 可并行；S3、S4 依赖 shared 路径策略稳定；S5 可在 S1–S4 后统一清理；S6 依赖部署环境，独立推进。

## 6. 每阶段验证

```bash
npm run typecheck
npx vitest run tests/runtime/ipc-contract.test.ts tests/runtime/runtime-tool-authorization.test.ts tests/runtime/capability-guards.test.ts tests/runtime/chat-persistence-domain.test.ts
npm run verify:preload-strangler
npm run verify:permission-policy
git diff --check
```

S6 额外：

```bash
npm run build
npm run verify:ts-migration-exit   # 仅在发布级证据补齐后
```

## 7. 完成标准

- G1：严格模式拒绝一切未登记通道；无 `legacyRendererChannels` 后门。
- G2：类型门面仅接受已登记 Channel；高敏通道均有 Schema。
- G3：runtime 工具与 shared 共享同一路径策略，无内联副本。
- G4：交互运行与后台运行共用 Capability 决策。
- G5：无零消费 selector；Schema 键名与字面量一致。
- G6：迁移台账 P1/P10/P12 与真实主站证据补齐，严格门禁目标状态可评估。

## 8. 遗留约束

- `npm run test:runtime` 在 Windows 环境的符号链接、权限、路径分隔符测试存在环境相关失败，需在具备 Developer Mode 的环境单独复测，不属于本计划默认范围。
