# Feature matrix: Ola 1.0.3 vs OpenCowork 1.2.0

Status is based on implementation evidence in the pinned local checkouts. `Different` means both
projects implement the domain but use materially different state, protocol, or interaction models.

| Capability            | Shared                   | Main / Native               | Preload                  | Renderer                        | Persistence              | UX                            | Status / decision                            |
| --------------------- | ------------------------ | --------------------------- | ------------------------ | ------------------------------- | ------------------------ | ----------------------------- | -------------------------------------------- |
| Agent stream protocol | Present                  | Native Worker stream        | Routed                   | Receiver present                | Message DB               | Streaming chat                | Present; verify behavioral drift             |
| Message windowing     | Contract present         | DB window routes            | Routed                   | Bounded context                 | SQLite                   | Transparent                   | Ola present; preserve verifier               |
| Pet                   | Types embedded in stores | Window IPC                  | Pet channels             | Multi-pet + compatibility store | Zustand multi-store      | Multi-pet desktop/list/editor | Different; Ola model is authoritative        |
| Credentials/login     | Shared credential types  | Ola secret vault            | Credential IPC           | Login agent and panels          | Main-only secrets        | Guided login                  | Ola-only stronger base; preserve             |
| Hooks                 | Missing                  | Missing                     | Missing                  | Missing                         | Missing hook DB          | Missing                       | OpenCowork candidate for PR 4                |
| Permissions UI        | Policy exists            | Partial Worker enforcement  | Existing approval bridge | No settings panel               | Settings policy          | Runtime dialog only           | Complete in PR 1/4                           |
| Browser cookie import | Missing                  | Missing                     | Missing                  | Login flow lacks import         | Vault can receive result | Missing                       | Adapt into Ola credentials in PR 5           |
| Input drafts          | Store exists             | Incomplete vs reference     | Partial                  | Store present                   | Renderer persistence     | Partial restore               | Complete in PR 2                             |
| Chat content blocks   | Partial                  | Runtime data present        | Routed                   | Missing specialized blocks      | Messages DB              | Generic rendering             | Add typed blocks in PR 2                     |
| AI Coding Terminal    | Missing                  | Terminal base exists        | Terminal IPC exists      | Missing integration             | Settings                 | Missing panel                 | Reuse Ola PTY lifecycle in PR 6              |
| Draw graph            | Basic draw runs          | DB routes exist             | DB IPC                   | Simple page                     | Draw runs DB             | No node canvas                | Replace UI model in PR 6, keep Ola providers |
| Seedance              | Missing                  | Worker module missing       | Missing                  | Missing                         | Job state missing        | Missing                       | Full TS/C# vertical slice in PR 6            |
| Distribution/update   | Partial                  | Updater exists              | Update IPC               | Basic update UI                 | Settings                 | Missing rich release notes    | Complete with Ola identity in PR 7           |
| Dev/log safety        | Shared stream bounds     | Ola launch script; log gaps | N/A                      | N/A                             | Crash logs               | Console noise                 | Harden in PR 1; keep `OLA_*`                 |

## Pet code-level invariant

Ola's `pets-store` remains the domain source of truth. `activePetId` is the settings/editor target,
`activeOnDesktopId` is the interactive desktop target, and `enabledIds` controls the available
collection. Wallet and unallocated experience remain user-level resources. OpenCowork's single-pet
Overview, Stats, Agent, Memory, Skins, and Studio interactions must be parameterized by `petId`; its
single-pet persistence must not be copied. [source:src/renderer/src/stores/pets-store.ts]
[source:src/renderer/src/stores/pet-wallet-store.ts]
[source:src/renderer/src/stores/pet-resource-pool-store.ts]
