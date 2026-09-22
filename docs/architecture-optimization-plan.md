# Ola 架构优化与安全收敛计划

> 目标分支：`main-ts`
>
> 本文是 Ola 当前 TypeScript Runtime 架构的优化基线，也是后续实施、验收和回滚的唯一计划入口。
>
> 约束：所有改造必须保持现有 Runtime、Workspace 授权、数据库 handover、MessagePack、消息渠道和既有用户数据兼容。提交描述只使用 Ola 自身模块和能力，不引用外部项目名称。

## 1. 当前问题基线

### 1.1 Preload 是泛化 IPC 转发

当前 `src/preload/index.ts` 暴露了 `window.ola.ipc.invoke/send/on`，Channel 是任意字符串；`src/preload/index.d.ts` 也只提供泛型签名。媒体和 Team Runtime 已经有域化 API，但绝大多数业务仍通过通用 IPC。

风险：

- Channel 名称无法在 Preload 层统一校验
- Renderer 能调用的能力边界不集中
- 敏感 Handler 依赖各自实现 sender、Workspace 和权限校验
- IPC 类型容易在 Main、Preload、Renderer 之间漂移

### 1.2 IPC Channel 来源分散

当前 Channel 主要分布在：

- `src/renderer/src/lib/ipc/channels.ts`
- `src/shared/messagepack/binary-ipc.ts`
- 各个 `src/main/ipc/*-handlers.ts`
- `src/preload/index.ts`

需要建立 Shared Contract，统一维护 Channel 名称、传输方式、Workspace 要求和权限元数据。

### 1.3 Store 体积过大

重点文件：

- `src/renderer/src/stores/chat-store.ts`
- `src/renderer/src/stores/agent-store.ts`

`chat-store` 同时承担 Session、消息、流式状态、项目、缓存和持久化队列；`agent-store` 同时承担 Run、Tool Call、审批、子 Agent 和进程状态。

目标是保持原有导出兼容，逐步拆成 Session、Message、Streaming、Project、Approval、Sub-agent 等独立状态域。

### 1.4 工具权限需要统一

现有基础：

- `src/shared/permission-policy.ts`
- `src/main/runtime/runtime-tool-authorization.ts`
- Workspace authorization
- sender trust checks
- 交互确认机制

后续需要把文件、Shell、网络、Browser、Credentials、插件能力统一为 Capability 授权模型。`requiresApproval` 只表达是否需要用户交互，不能替代路径、命令、Workspace 和资源权限校验。

## 2. 不变量与禁止事项

以下行为在优化过程中不得破坏：

1. 不得在全部调用迁移前删除 `window.ola.ipc`。
2. 不得绕过 `authorizeDbWorkspace`、窗口 Workspace 注册和 Runtime owner 校验。
3. 不得削弱 Bash、Shell、PowerShell、Monitor 的主进程确认机制。
4. 不得恢复不安全的动态 JS 扩展执行。
5. 不得改变 Session、Message、Workspace、Run 的持久化语义和 ID。
6. 不得让 Renderer 直接访问 Node.js、文件系统、凭据或 Shell。
7. 不得在日志、错误、Runtime Event 和崩溃报告中写入凭据明文。
8. 所有迁移必须可回滚；优先新增兼容层，再迁移调用方，最后收紧旧入口。

## 3. 目标架构

```text
React Components
  ↓
Feature Hooks
  ↓
Session / Agent Stores
  ↓
Typed Services
  ↓
Shared IPC Contract
  ↓
Preload Allowlist
  ↓
Main Handler
  ↓
Sender + Workspace + Capability Authorization
  ↓
Desktop Runtime / Runtime Server
  ↓
Agent / Scheduler / Provider / Storage
```

## 4. 分阶段实施计划

### P0：架构基线

建立 IPC、Store、Tool、Handler 清单，不改变运行行为。

交付物：

- IPC Channel inventory
- Handler 与 sender / Workspace / permission 覆盖表
- Store 外部调用关系
- 高风险工具调用链
- 架构静态验证脚本

提交：

```text
chore(architecture): inventory ipc store and tool boundaries
```

### P1：统一 Shared IPC Contract

新增：

```text
src/shared/ipc/contract.ts
src/shared/ipc/types.ts
```

Contract 至少描述：

- Channel 名称
- JSON 或 MessagePack 传输方式
- Workspace 要求
- Sender 类型
- 权限标识

第一步将旧 `channels.ts` 改为兼容 re-export，保持 `IPC.X` 调用不变。

提交：

```text
refactor(ipc): centralize shared channel contracts
```

### P2：类型化 IPC Client

新增：

```text
src/renderer/src/lib/ipc/typed-ipc-client.ts
```

目标：

- 根据 Channel 推导请求和返回类型
- 统一 `IpcResult`
- 禁止新增未登记 Channel
- 保留旧 `ipcClient` 作为迁移兼容层

提交：

```text
feat(ipc): add typed invoke and event client
```

### P3：Preload 域化

逐步增加：

```text
window.ola.settings
window.ola.sessions
window.ola.messages
window.ola.runtime
window.ola.files
window.ola.shell
window.ola.browser
window.ola.credentials
window.ola.plugins
window.ola.mcp
```

先迁移低风险域，再迁移文件、Shell、Browser 和 Credentials。

提交：

```text
feat(preload): add domain-scoped renderer bridges
```

### P4：Preload 运行时白名单

新增 Invoke、Send、Event、MessagePack Channel 白名单。旧通用 IPC 在迁移期间保留，但禁止新增调用。

提交：

```text
fix(preload): enforce ipc channel allowlists
```

### P5：统一 Tool Capability

新增 Capability 类型和统一评估器，覆盖：

- `filesystem.read`
- `filesystem.write`
- `shell.execute`
- `network.request`
- `browser.execute`
- `credential.readPlaintext`
- `credential.inject`
- `plugin.tool`

统一判断顺序：sender → window → Workspace → capability → 资源规则 → deny → user approval → execute。

提交：

```text
feat(security): unify tool capability authorization
```

### P6：路径、命令和网络防护

新增：

```text
src/main/security/path-guard.ts
src/main/security/command-guard.ts
src/shared/security/path-policy.ts
src/shared/security/command-policy.ts
```

覆盖路径逃逸、符号链接、Shell expansion、命令串联、重定向、私有网络、URL 重定向和 Browser Script 资源绑定。

提交：

```text
feat(security): add workspace path and command guards
fix(security): tighten network browser and credential capabilities
```

### P7：Agent Store 拆分

将 `agent-store.ts` 拆为：

- Agent Run
- Tool Call
- Approval
- Sub-agent
- Process

保留 `useAgentStore` 兼容组合入口。

提交：

```text
refactor(store): split agent runtime state slices
```

### P8：Chat Store 拆分

将 `chat-store.ts` 拆为：

- Session
- Message
- Streaming
- Project
- Session Cache
- Message Window
- Persistence Queue

保持 Session、Message、Workspace 和数据库写入语义不变。

提交：

```text
refactor(store): isolate chat session and message state
```

### P9：Renderer 边界

新增静态检查：

- 组件不得直接调用 `ipcClient`
- 组件不得直接访问 `window.ola.ipc`
- Store 不得依赖 React 组件
- IPC Service 不得依赖 Store
- Runtime Projection 只能通过 Store Action 更新状态

提交：

```text
refactor(renderer): enforce store and ipc boundaries
```

### P10：Extension Capability

扩展 Manifest 声明能力，安装和运行时分别校验能力、路径、网络和凭据访问。继续保持动态 JS 扩展隔离。

提交：

```text
feat(extensions): add capability declarations and validation
```

### P11：架构验证门禁

新增或完善：

```text
verify:ipc-contract
verify:ipc-channel-inventory
verify:preload-allowlist
verify:renderer-boundaries
verify:tool-capabilities
verify:store-boundaries
```

纳入 `verify:ci-core`。

提交：

```text
test(architecture): add ipc store and capability regression gates
```

## 5. 第一批实施范围

当前先实施 P1 的安全基础，不直接改动所有业务调用：

1. 将 `IPC` 常量迁移到 `src/shared/ipc/contract.ts`。
2. 让 Renderer 旧 `channels.ts` 通过 re-export 兼容。
3. 将 MessagePack Channel 统一纳入 Shared IPC Contract。
4. 为 Preload 增加基于 Contract 的 Channel 判断函数，但先以兼容模式运行。
5. 为 JSON IPC 和 MessagePack IPC 增加最小类型化调用基础。
6. 运行 typecheck、lint、runtime tests 和现有安全校验。

### 第一批实施进度

- [x] 创建 `src/shared/ipc/contract.ts`，集中维护现有 IPC 常量。
- [x] 将 Renderer 的 `channels.ts` 改为 Shared Contract 兼容 re-export。
- [x] 增加 `isKnownIpcChannel()` 基础判断函数，暂不改变旧通用 IPC 的运行行为。
- [x] 将 MessagePack Channel 注册表合并到同一份 Contract。
- [x] 增加 JSON IPC 的过渡型 `TypedIpcClient`，暂不改变底层传输。
- [x] 增加 MessagePack 类型化 Client（`invokeMessagePack` 经 Preload 与类型化门面）。
- [x] 增加 Preload 兼容模式校验；通过 `OLA_STRICT_IPC_ALLOWLIST=1` 开启拒绝未登记 Channel。
- [x] 迁移全部调用方并默认启用严格 Preload 白名单（生产环境默认启用；遗留 Channel 已显式登记，不再按前缀放行）。

当前验证结果：

- `npm run typecheck`：通过。
- `npm run lint`：通过，但仓库已有大量 CRLF 格式警告，未在本阶段扩大格式化范围。
- `npm run verify:preload-strangler`：通过。
- `npm run test:runtime`：执行失败，当前失败集中在 Windows 环境的符号链接创建、文件权限/`fsync`、路径分隔符和已有 Runtime 行为测试，不是 IPC 改动直接报错；需单独修复或在具备 Developer Mode 的环境复测。
- `npx vitest run tests/runtime/ipc-contract.test.ts tests/runtime/runtime-tool-authorization.test.ts`：7 个测试通过。
- `src/shared/capabilities.ts` 已建立统一 Tool Capability 类型和策略入口，并接入后台 Runtime 授权路径。
- `src/shared/security/path-policy.ts` 和 `command-policy.ts` 已加入路径越权、空命令、复合命令和重定向的基础防护。
- `agent-types.ts` 已抽离 Agent Store 的纯类型，原 `agent-store.ts` 导出保持兼容；完整 Store 行为拆分仍待后续批次。
- `npm run typecheck`：通过。
- `npx vitest run tests/runtime/ipc-contract.test.ts tests/runtime/runtime-tool-authorization.test.ts tests/runtime/capability-guards.test.ts`：9 个测试通过。
- 已新增 `chat-store-selectors.ts`，将 Session、消息、流式消息和 Project 查询逻辑抽为独立域选择器，并由 `chat-store.ts` 兼容导出。
- 已新增 `agent-store-selectors.ts`，将 Run、Session 状态、重试、Tool Call、Sub-agent 和变更集查询逻辑抽为独立域选择器，并由 `agent-store.ts` 兼容导出。
- 已将 `chat-route.ts` 的 Settings 查询迁移到 `typedIpcClient`。
- Preload 生产环境默认启用严格 Channel 校验，开发环境可通过 `OLA_STRICT_IPC_ALLOWLIST=1` 提前启用。
- 当前 Store 的读取域已经拆分，Chat Store 的按 Session 持久化队列已抽至 `chat-persistence-domain.ts`；旧 Store 导出继续作为兼容入口。
- `ipcClient` 现在是 `typedIpcClient` 的兼容别名，现有调用方统一经过类型化 IPC 门面；MessagePack 底层路由仍由该门面统一处理。
- 生产环境默认严格校验已登记 Channel，遗留域 Channel 通过 Shared Contract 的显式登记覆盖；开发环境可用 `OLA_STRICT_IPC_ALLOWLIST=1` 提前启用。
- 遗留 Channel 已从“前缀兜底”收紧为 115 个显式字面量登记，未登记的 `app:unknown` 等不再放行。
- `path-policy.ts` 已加入 `fs.realpath` 符号链接逃逸校验，配合 Capability 统一决策。
- 已在 `src/shared/ipc/types.ts` 建立 `ipcChannelSchema` 请求/响应契约，`typedIpcClient.invoke` 按 Channel 推导响应类型；未登记的 Channel 暂以 `unknown` 兜底，后续逐个细化。

## 5.1 第二批实施进度

- [x] 审计并修正 IPC、Preload、Store 兼容性。
- [x] 补齐 MessagePack 类型化调用入口。
- [x] 接入真实路径（符号链接）Capability 校验。
- [x] 完成 Agent/Chat Store 读取域与持久化写入域拆分。
- [x] 全部 IPC 调用统一经过类型化门面，生产环境默认严格白名单。
- [x] 建立各 Channel 请求/响应 Schema 契约并接入类型化调用。
- [x] 清理误生成的临时脚本和异常命名文件。

验证结果：

- `npm run typecheck`：通过。
- 架构回归测试：13 个全部通过（ipc-contract 3、runtime-tool-authorization 5、capability-guards 3、chat-persistence-domain 2）。
- `git diff --check`：无空白错误。
- 工作区无异常文件残留。

## 6. 验收命令

```bash
npm run typecheck
npm run lint
npm run test:runtime
npm run verify:permission-policy
npm run verify:preload-strangler
npm run verify:desktop-ipc-authorization
npm run verify:workspace-isolation
npm run runtime:build
npm run verify:runtime-staging
```

## 7. 完成标准

### IPC

- 新增 Channel 必须登记在 Shared Contract。
- 普通和 MessagePack Channel 有统一来源。
- Preload 可拒绝未登记 Channel。
- 旧调用只有兼容期可继续存在。

### Store

- Agent 和 Chat 状态按领域拆分。
- 原有兼容入口仍然可用。
- Session 消息驻留和数据库持久化行为不变。

### 权限

- 前台、后台、Cron、子 Agent、Team Runtime 使用同一套 Capability 规则。
- 文件不能逃逸 Workspace。
- Shell 不能绕过 Command Guard。
- Browser 和 Credential 能力必须绑定资源和 Workspace。

### 质量

- `npm run typecheck` 通过。
- `npm run lint` 通过。
- 相关 Vitest 和 verify 脚本通过。
- 每个阶段都有独立、可回滚的提交。
