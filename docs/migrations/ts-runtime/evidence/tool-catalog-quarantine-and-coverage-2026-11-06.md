# 工具目录隔离与覆盖门禁（2026-11-06）

## 报告与问题

用户在收口 `MESSAGE_CONTENT_NOT_MIGRATED` 之后追问「还有没有这样的报错」。同类错误的形态是同一个：
迁移闸门判定当前请求无法交给 Main 侧 TS runtime，于是整个请求不发出，界面只显示
`Agent failed TS_RUNTIME_AGENT_UNAVAILABLE: <REASON>`。逐项排查结论：

| 闸门理由                                                             | 是否仍可从界面触发 | 说明                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE_NOT_MIGRATED`                                                  | 否                 | `SessionMode` 联合类型（`chat`/`clarify`/`execute`，`src/renderer/src/stores/chat-store.ts:87`）与闸门允许的模式列表完全一致；旧值 `cowork`/`code`/`acp` 在读写两侧由 `normalizeSessionMode`（同文件 `:91`，用于 `:1755`、`:3892`、`:4356`）归一化为 `execute`。 |
| `TOOLS_NOT_MIGRATED`                                                 | **是**             | 四个开关型能力注册的工具名不在允许列表内，见下。                                                                                                                                                                                                                 |
| `MESSAGE_CONTENT_NOT_MIGRATED`                                       | 已修               | 见 [reported-chat-errors-and-transcript-replay-2026-11-06.md](reported-chat-errors-and-transcript-replay-2026-11-06.md)。                                                                                                                                        |
| `PLUGIN_NOT_MIGRATED` / `CHANNELS_NOT_MIGRATED` / `SSH_NOT_MIGRATED` | 是，但语义正确     | 这些能力确实尚未迁移，提示的是真实缺口。                                                                                                                                                                                                                         |

## 结论：同一族的下一个缺陷

`TOOLS_NOT_MIGRATED` 不需要任何异常输入，只要用户打开一个开关：

| 能力      | 入口                                                           | 注册的工具名                                                                       |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 高级绘图  | 设置 → 高级 → `advancedDrawEnabled`                            | `CanvasOperation`                                                                  |
| 视频生成  | 设置 → 视频 → `videoGenerationEnabled`                         | `GenerateVideo`                                                                    |
| CodeGraph | 应用插件 `codegraph`                                           | `codegraph_explore`                                                                |
| 桌面控制  | 应用插件 `desktop-control`（`hidden: true`，设置面板里看不见） | `DesktopScreenshot`、`DesktopClick`、`DesktopType`、`DesktopScroll`、`DesktopWait` |

工具注册是去中心化的（任何模块都能 `toolRegistry.register`），而迁移闸门是一张硬编码白名单，
两者之间没有任何约束把它们绑在一起。因此「装上一个插件 → 聊天从此不可用」是一条可重复的通路，
且失败面是整个会话，而不是那一个能力。本机 `~/.ola/config.json` 中 `codegraph` 与
`desktop-control` 均为 `enabled: false`，两个设置项默认也是关闭，所以这是潜伏缺陷，不是当天报错的成因。

## 处理原则（用户选定）

「剔除 + 显式提示」：把这四个能力从该次运行的工具快照中剔除，聊天照常进行，并在会话里明确写出
本次运行不含哪些能力；同时加门禁，注册表出现未登记的名字直接报错。

## 改了什么

1. **一份写明了理由的隔离名单。**
   `TS_RUNTIME_UNMIGRATED_CAPABILITY_TOOLS`（`src/renderer/src/lib/ipc/ts-runtime-text-eligibility.ts:124`）
   只收录「由设置或插件开关注册、且 Main 侧确实没有对应工具」的名字。名单外的未知名字依旧 fail closed：不被记录的剔除，正是模型承诺它做不到的活的方式。
2. **闸门剔除，其余照旧。** `assessTsRuntimeAgentEligibility`
   （`src/renderer/src/lib/ipc/ts-runtime-agent-eligibility.ts:61`）先把名单内的名字从工具快照里去掉，
   再调用 `supportsTsRuntimeAgentTools`；剔除后仍剩下不允许的名字，理由依旧是 `TOOLS_NOT_MIGRATED`。
   该函数同时服务于 channel、pet、auto-reply 等提交路径，因此它们也一起受益。
3. **模型不会被提供给一个它调不动的工具。** 目录收窄发生在唯一的快照出口
   （`src/renderer/src/lib/agent/chat-send-message.ts:893`），系统提示、运行请求的工具列表与闸门检查
   看到的是同一份收窄后的快照，不会出现在提示里画了一套、提交时又少一套。诊断日志新增
   `droppedCapabilities` 字段。
4. **被剔除的能力写进会话。** `meta.capabilityNotice`
   （`src/renderer/src/lib/agent/chat-send-message.ts:1640`，类型见
   `src/renderer/src/lib/api/types.ts:227`）由 `RunCapabilityNotice`
   （`src/renderer/src/components/chat/AssistantMessage.tsx:515`）渲染为一条提示。名称到文案的映射放在
   `src/renderer/src/lib/run-capability-labels.ts:6`，五个桌面控制工具折叠为一条「桌面控制」，
   文案覆盖 16 个语言的 `chat.json`。
5. **门禁：目录与闸门必须互相解释。** 新增
   `tests/runtime/renderer-tool-catalog-coverage.test.ts`（5 个用例，由 `npm run test:runtime` 执行，
   CI 已经在跑这条命令），它
   - 重新解析 `src/renderer/src/lib/tools/index.ts` 的真实接线，`registerAllTools` 里新增一个注册函数
     却没在门禁里说明，直接红；
   - 逐个检查注册表与 `APP_PLUGIN_DESCRIPTORS[].toolNames` 发布出来的名字，必须落在允许列表、
     MCP/extension 命名形态或隔离名单里；
   - 隔离名单里如果存在目录已经不再发布的名字，同样红（陈旧的隔离项会掩护下一个真正未迁移的名字）；
   - 隔离名单与文案映射必须一一对应，且 16 个语言的 `runCapability.*` 都存在、`detail` 保留
     `{{tools}}` 占位符。
6. **顺手修掉一个未处理的 rejection。** 子代理历史迁移失败时的重试是 `void` 出去的
   （`src/renderer/src/stores/agent-store.ts:841`），一旦有测试引入工具目录就会让整套
   `vitest run` 以非零码退出。现在重试的失败会被记录而不是抛出。

## 实验证据

同一个探针跑两遍：对四个能力分别构造 Execute 请求，工具快照为 `Read`/`Write`/`Bash` 加上该能力的
工具名，只改变隔离名单是否为空。

| 能力                          | 名单置空（改动前）   | 名单生效（改动后） |
| ----------------------------- | -------------------- | ------------------ |
| 高级绘图 `CanvasOperation`    | `TOOLS_NOT_MIGRATED` | `eligible: true`   |
| 视频生成 `GenerateVideo`      | `TOOLS_NOT_MIGRATED` | `eligible: true`   |
| CodeGraph `codegraph_explore` | `TOOLS_NOT_MIGRATED` | `eligible: true`   |
| 桌面控制 `Desktop*` 五个名字  | `TOOLS_NOT_MIGRATED` | `eligible: true`   |

门禁自身的红/绿也做过反向验证：

- 在 `src/renderer/src/lib/tools/index.ts` 里临时插入一行 `registerTelemetryTools()` 调用，
  接线用例报 `expected [ 'registerTelemetryTools' ] to deeply equal []`；
- 从隔离名单里临时删掉 `CanvasOperation`，两个用例同时报红
  （`expected [ 'CanvasOperation' ] to deeply equal []` 与名单/映射不一致），说明「未登记的名字」和
  「陈旧的隔离项」都不是摆设断言。

两次改动都只在临时副本上进行，运行结束后已还原（还原后 `git diff` 与本次改动的预期一致）。

## 测试

- `tests/runtime/renderer-tool-catalog-coverage.test.ts`（5，新增）：接线完整性、目录名字覆盖、
  插件描述符覆盖、隔离名单不陈旧、名单/文案映射与 16 语言一致。
- `tests/runtime/ts-runtime-agent-eligibility.test.ts`（30 → 39，新增 9）：八个隔离名字逐个
  「剔除后可运行、但不允许列表」的对照，加一个「名单外名字仍然 fail closed」。

## 验证

| 命令                        | 结果                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`         | 通过                                                                                                                           |
| `npm run typecheck:runtime` | 通过（同时修掉了 24f95ca 遗留在 `ts-runtime-text-eligibility.test.ts` 的两处 `createdAt` 类型错误，此前该门禁是红的）          |
| `npm run lint`              | 通过                                                                                                                           |
| `npx prettier --check .`    | 通过                                                                                                                           |
| `npm run verify:i18n`       | 通过，`unresolvedKeys` 为空                                                                                                    |
| `npm run test:runtime`      | 332 个文件（325 通过、7 跳过，含新增的 `renderer-tool-catalog-coverage.test.ts`）；1594 个用例（1584 通过、10 跳过），退出码 0 |

## 这不能证明

- 四个能力本身仍然不可用。这次改动只让「打开开关不再摧毁聊天」，没有把 CanvasOperation、
  GenerateVideo、`codegraph_explore` 和桌面控制移植成 Main 侧 TS 工具；提示条说的就是这件事。
- 提示条的渲染没有端到端证据。会话通知走 `meta.capabilityNotice` → `RunCapabilityNotice`，
  自动化测试覆盖的是名称/文案映射与 16 语言完整性，不是像素；需要在 UI 里确认时要先打开一个开关
  再发一条消息。
- 目录收窄发生在 `chat-send-message` 的快照出口。若日后新增别的提交入口而绕过它，模型仍可能在提示里
  看到一个调不动的工具；门禁只能保证名字被登记，不能保证每个调用方都做了收窄。
- 桌面控制插件在设置面板里是隐藏的（`hidden: true`），用户无法通过可见面板关掉它来复现当时的报错；
  本机该插件为关闭状态，所以这条通路对本机配置是潜伏的。
