# server/ — moved to Ola-admin

The production Ola control plane (accounts, devices, pairing, remote-access permissions,
signaling hub, mesh events, model gateway) lives in the separate **Ola-admin** repository.
The Go copy that used to sit here had diverged from production and was removed on 2026-11-09
to keep a single source of truth.

- Desktop development against a local control plane: run Ola-admin with
  `OLA_REMOTE_DEV_MODE=1` (API :7300, signaling :7301).
- Go quality gates (gofmt / vet / test) and console tests run in Ola-admin's own CI
  (`.github/workflows/ci.yml`).
- Remote-control end-to-end probe: `docs/qa/remote-access-e2e.mjs` (needs a running Ola-admin).

生产控制面在独立的 **Ola-admin** 仓库维护，此处旧副本已删除。本地联调用 Ola-admin 的
`OLA_REMOTE_DEV_MODE=1`；Go 测试在 Ola-admin 自己的 CI 中运行。
