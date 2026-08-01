---
name: release-readiness
description: Audit a software repository for concrete release blockers and verification gaps. Use before packaging, tagging, publishing, deploying, or handing off a release candidate, including checks for source state, tests, build outputs, migrations, secrets, artifacts, and rollback readiness.
---

# Release readiness

Perform an evidence-backed, read-only audit by default. Do not publish, tag, push, deploy, or change version numbers unless the user explicitly requests that action.

## Establish the release target

1. Read repository instructions and release documentation.
2. Identify the intended branch, version, platform targets, and packaging command.
3. Inspect the worktree and recent commits so local changes are not accidentally omitted.
4. Find CI workflows and determine which local checks correspond to required jobs.
5. Note any checks that require credentials, signing identities, hardware, or external services.

If the target is ambiguous, continue with safe checks and state the assumption in the result.

## Audit source integrity

- Confirm the worktree contains only intentional files.
- Inspect staged and unstaged diffs, untracked files, submodules, and lockfile changes.
- Search tracked additions for credentials, tokens, private keys, absolute local paths, user data, caches, logs, and generated binaries.
- Confirm ignore rules cover build output and runtime data.
- Check that version declarations agree across manifests and packaging configuration.
- Verify release notes describe the current behavior and do not promise incomplete capability.

Never print secret values. Report only the file, category, and remediation.

## Validate compatibility and data safety

- Inspect schema and persistence changes for additive, idempotent migration behavior.
- Check new fields against older saved state and missing configuration.
- Verify feature flags gate registration and background runtime work, not only UI visibility.
- Confirm disabled features preserve existing user data.
- Check update, downgrade, rollback, and interrupted-upgrade behavior where applicable.
- Verify platform-specific paths, permissions, native dependencies, and packaging assets.

## Run proportional gates

Use the repository's documented commands. Prefer this order so failures remain easy to diagnose:

1. targeted verification scripts;
2. type checking or compilation;
3. lint and formatting checks;
4. unit and integration tests;
5. production build;
6. native worker or sidecar build;
7. package or installer smoke test when requested and feasible.

Capture command, exit status, and the relevant failure. Do not hide failures by rerunning with weaker flags. Distinguish a failed check from a check that could not run in the current environment.

## Inspect packaged output

When a package is available:

- confirm expected application files and native components are present;
- verify development files, caches, credentials, source maps, and user data are absent unless intentionally shipped;
- inspect file sizes for unexpected growth;
- verify executable permissions and platform architecture;
- perform a minimal launch smoke test if the environment supports it;
- do not sign, notarize, upload, or publish without explicit authorization.

## Assess rollback and operations

- Identify the last known good version and recovery path.
- Confirm migrations and background jobs tolerate restart or partial completion.
- Check whether feature flags can disable risky optional capability.
- Verify logs provide actionable diagnostics without leaking sensitive data.
- Note monitoring or post-release checks that cannot be exercised locally.

## Return the verdict

Use one of these outcomes:

- Ready: required gates passed and no material blocker remains.
- Ready with caveats: releasable, but explicitly listed checks remain external or optional.
- Not ready: one or more concrete blockers remain.

List blockers first, then passed gates, skipped gates with reasons, and the smallest next actions. Do not equate a successful build with complete release readiness.
