# Windows 文件身份精度与旧库交接回归（2026-10-03）

## 问题与修复

在 Windows 全量运行时测试中，旧库交接测试曾分别随机出现 4 项和 5 项
`BUSINESS_HANDOVER_ROLLBACK_UNSAFE` 失败；该测试文件单独运行 64/64 通过。
交接验证使用默认 `fs.stat`/`fs.lstat` 的 Number 型 `ino`/`dev` 判断备份、源库及回滚基线是否为同一文件。
本机抽样的文件 `ino` 超过 JavaScript 安全整数范围；其中一个文件的 Number 值与 BigInt 值相差 1。
这会让文件身份比较丢失精度，存在把不同文件误判为同一文件的可能。

`src/runtime/storage/business-worker.mjs` 和
`src/runtime/storage/legacy-database-handover.ts` 的文件身份检查现使用
`{ bigint: true }` 读取精确 `ino`/`dev`。同一 Stats 对象上的模式、大小比较也改为 BigInt，
保留原有回滚基线、备份安全条件和错误码。

继续排查时发现 `src/runtime/tools/local-shell-command.ts` 的声明产物变更识别也使用
Number 型 `ino`。现改为精确的 `ino`/`dev`，并以纳秒级修改/创建时间和 BigInt 文件大小比较，
避免大文件标识的舍入造成替换漏报。该处专项 4/4、Runtime 类型检查、定向 ESLint 和
Prettier 检查通过；完整生产构建在交互终端下通过。

## 验证

- `npm run typecheck:runtime`：通过。
- `npm run typecheck`：通过。
- `npm run test:runtime`：独立连续运行两次，均为 263 个测试文件通过、5 个跳过；1082 项通过、16 项跳过，无失败。
- `npm run verify:ci-core`：通过。
- `npm run lint`：退出码 0，0 错误；仓库 CRLF 行尾导致 124243 条 Prettier 警告，格式门禁仍需单独治理。

上述两次全量复跑证明本机当前代码在该测试范围内通过；不能据此替代其他平台的原生安装与升级验收。
