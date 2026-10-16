# G4 desktop remote-input release contract — 2026-10-10

## Coverage added

Added `tests/runtime/remote-input-controller.test.ts` in the Ola desktop repository. The cases exercise the actual main-process remote input controller with mocked OS input calls and deterministic display bounds:

1. A held key and pointer button are released immediately when desktop remote-control authorization is revoked; subsequent input is denied.
2. Disconnecting the owning renderer's session releases held keys and denies later input for that session.
3. A different renderer cannot clear the active session; valid input remains scoped to its owner.

## Verification

```text
npm test -- --run tests/runtime/remote-input-controller.test.ts
```

Result: **1 test file passed, 3 tests passed, 0 failed**.

## Acceptance boundary

This verifies desktop main-process authorization/release behavior with mocked OS input and display services. It does not exercise an actual phone, live Ola signaling, native WebRTC, visible desktop input, or TURN. The G4 end-to-end gate remains **IN PROGRESS / NOT READY**.
