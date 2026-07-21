# Phase 1: permission policy integration

## Reference evidence

- `OpenCowork/src/shared/permission-policy.ts`
- `OpenCowork/sidecars/OpenCowork.Native.Worker/Modules/AgentRuntime/AgentRuntimePermissionPolicy.cs`
- `OpenCowork/src/renderer/src/components/settings/PermissionPanel.tsx`
- `OpenCowork/src/renderer/src/components/cowork/PermissionDialog.tsx`

## Ola adaptation

- The policy is persisted inside `ola-settings`, sanitized during migration and disabled by
  default. No OpenCowork storage key enters Ola data.
- Renderer-built runs include a minimized policy snapshot. Main injects the sanitized persisted
  snapshot for alternate run initiators, while cron runs include it explicitly.
- `Ola.Native.Worker` is the enforcement boundary. Command deny rules are evaluated before
  approval and execution, including when global auto-approval is enabled. Allow rules only skip
  confirmation and never override deny rules.
- Settings and the approval dialog provide English and Chinese management text. Other locales use
  the established English fallback.

## Deliberately rejected behavior

- No policy is enabled automatically for upgraded users.
- No rules or command history are copied from the reference product.
- Renderer evaluation is not treated as a security boundary.

## Follow-up debt

- Hooks may add a pre-tool decision only after Phase 4 establishes hash-bound trust. Hook allow
  decisions must remain subordinate to this policy's deny result.
