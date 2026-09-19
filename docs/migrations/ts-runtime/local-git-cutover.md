# 本地 Git TS 切换验收记录

本记录只覆盖没有 `sshConnectionId` 的 Git IPC。SSH Git 继续由 Native SSH 适配执行，不能据此删除远端 Git 路径。

## 已由 Main TS 执行的本地操作

- 只读：仓库扫描、状态详情、仓库摘要、提交／分支／差异／文件历史查询。
- 写入：fetch、pull --rebase、push、分支创建／切换／合并／变基／删除／重命名、暂存／取消暂存、恢复和提交。
- 所有 Git 进程以 `shell: false` 启动；分支、引用、远端和路径在构造参数前进行边界验证。

## 保留契约

- 仓库扫描不跟随符号链接，跳过默认构建与依赖目录；发现根仓库后不递归报告其嵌套仓库，与旧 Worker 一致。
- 状态详情解析 `git status --porcelain=v1 -b`，返回 branch、upstream、ahead/behind 与 staged、unstaged、untracked、conflicted 分组。
- mutation 成功后会使本地 Git 查询缓存失效。

## 证据

- `tests/runtime/git-mutation.test.ts`：临时仓库中的 TS 暂存／提交和危险参数拒绝。
- `tests/runtime/git-scan.test.ts`：深度、排除目录与根仓库语义。
- `tests/runtime/git-status.test.ts`：porcelain 解析和真实状态。

删除 Native Git 路由前，仍须补充本地 IPC 端到端测试、性能比较，以及 SSH 宿主的独立迁移。
