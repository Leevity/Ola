# agent-desktop binaries

The executables under `resources/agent-desktop/<platform>-<arch>/` are unmodified
builds of [agent-desktop](https://github.com/vercel-labs/agent-desktop), a Rust CLI
that reads and drives desktop applications through the OS accessibility APIs
(macOS Accessibility, Windows UI Automation, Linux AT-SPI). They are distributed
under the upstream Apache License, Version 2.0.

- Upstream project: `https://github.com/vercel-labs/agent-desktop`
- Upstream license: `https://www.apache.org/licenses/LICENSE-2.0`
- Pinned version and per-binary SHA-256: `../agent-desktop.lock.json`
- Pinned release checksums manifest SHA-256: `3f6372d8a74a1fca5e59e549251100aee6cada7d5e992c1c8234ebe68e3b9925`

These binaries are downloaded by `scripts/stage-agent-desktop.mjs` at build time and
are never committed. Each archive is fetched from GitHub Releases over HTTPS, hashed
against the lock file before extraction, and only the files named in the lock are
written to disk.

The macOS helper `agent-desktop-macos-helper` and the Linux helper
`agent-desktop-linux-clipboard-owner` must stay in the same directory as, and be built
for the same architecture as, the CLI that launches them.
