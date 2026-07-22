# SSH 能力差异审计

> 审计基线：Ola 阶段 9 合入后的本地 `main`，对照 1.2.2 锁定指纹。
> 结论：SSH 主要功能已经存在，后续应做契约和可靠性收敛，不应重新移植整套页面。

## 已具备能力

| 能力       | Ola 现状 | 证据                                                     |
| ---------- | -------- | -------------------------------------------------------- |
| 主机与分组 | 已完成   | connection/group CRUD、测试、排序、SQLite 持久化         |
| 导入导出   | 已完成   | OpenSSH 配置预览/导入、连接导出                          |
| 交互终端   | 已完成   | 多标签、resize、输出缓冲、启动命令、ProxyJump、keepalive |
| 文件工作区 | 已完成   | 浏览、分页、读写、编辑、上传下载、移动、删除、压缩       |
| 双栏 SFTP  | 已完成   | 双连接、选择、比较、冲突策略、跨主机传输                 |
| 密钥与信任 | 已完成   | Keychain 工作区、公钥安装、known_hosts 编辑              |
| 运维辅助   | 已完成   | 进程监控、端口转发模板、命令片段、连接与传输状态视图     |
| 独立窗口   | 已完成   | `appView=ssh` 的独立 SSH 工作台入口                      |

## 真实缺口

| 优先级 | 缺口                                      | 风险 / 收益                                  | 建议切片                                  |
| ------ | ----------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| P1     | Renderer SSH store 为 1909 行单体文件     | 修改互相影响、事件订阅难隔离                 | `codex/ssh-store-modules`                 |
| P1     | 跨进程连接契约仍散落在 handler/store      | 密码与 passphrase 能力标识、状态枚举容易漂移 | 与 store 模块化同阶段完成 shared contract |
| P1     | 缺少 `reconnecting` 和分阶段连接日志契约  | 网络抖动与认证失败难诊断                     | `codex/ssh-reconnect-logs`                |
| P2     | 失败传输没有保留原始请求用于 resume/retry | 大文件失败后需要重新配置任务                 | `codex/ssh-transfer-resume`               |
| P3     | 现有 forwarding/snippets 主要是本地模板   | 不是实际隧道生命周期管理                     | 后续按用户需求单独设计，不冒充已执行转发  |

## 推荐顺序

1. 先提取 shared contract，并把单体 store 按 connections、sessions、explorer、sftp、transfers、ui、events 拆分；保持行为不变。
2. 再增加重连状态、连接阶段日志与诊断 UI，避免在结构迁移时同时改变运行语义。
3. 最后补传输 retry/resume；必须使用原任务参数并验证取消、失败、续传竞态。
4. 端口隧道执行器属于新增能力，不能与模板 UI 混为一谈，也不应阻塞上述可靠性工作。

## 验收门禁

- `npm run typecheck`、`npm run lint`、`npm run build`
- `npm run verify:remote-store`
- 连接、断开、重连、终端输出缓冲人工烟测
- SFTP 分页、双栏跨主机传输、取消与续传人工烟测
