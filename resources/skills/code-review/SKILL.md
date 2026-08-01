---
name: code-review
description: Review code changes for defects, regressions, security issues, missing validation, and maintainability risks. Use when asked to review a diff, branch, commit, pull request, patch, or implementation without automatically changing it.
---

# Code review

Review the requested change set as a read-only investigation unless the user explicitly asks for fixes.

## Establish scope

1. Read repository instructions before inspecting code.
2. Determine the comparison base from the request. If unspecified, inspect status and recent history, then use the narrowest defensible diff.
3. Include staged, unstaged, and untracked files when reviewing local work.
4. Identify generated files, dependencies, migrations, public contracts, and configuration affected by the change.
5. Do not treat unrelated pre-existing changes as findings against the requested patch.

Prefer `git diff --stat`, `git diff --name-status`, and targeted file reads before loading a large diff.

## Trace behavior, not just syntax

For each changed behavior:

1. Follow inputs from the caller through validation and state changes to outputs.
2. Check both success and failure paths.
3. Inspect concurrency, cancellation, retries, cleanup, persistence, authorization, and compatibility when relevant.
4. Search for other callers and implementations of changed contracts.
5. Compare tests and validation scripts with the actual risk introduced.
6. Verify user-visible copy, accessibility, localization, and loading or empty states for UI changes.

Run focused static checks or tests when they materially confirm a concern. Do not mutate external systems or install dependencies merely to complete a review.

## Rank findings

Report only actionable defects or material risks:

- P0: immediate data loss, security compromise, or broadly unusable product.
- P1: likely severe failure in a normal supported path.
- P2: meaningful correctness, reliability, compatibility, or maintainability problem.
- P3: localized issue worth fixing but with limited impact.

Each finding must include:

- a concise title and priority;
- the smallest useful file and line range;
- the concrete execution path that triggers it;
- the resulting impact;
- why existing guards or tests do not prevent it.

Avoid speculative findings without a reachable scenario. Do not report formatting preferences already enforced by tooling.

## Check common failure classes

- Boundary validation differs across layers.
- New optional fields break old persisted data.
- Retries duplicate side effects.
- Cancellation is reported as failure or vice versa.
- Event listeners, timers, subscriptions, or processes leak.
- Authorization is checked on one route but omitted on a related route.
- Paths escape an intended root or follow unsafe links.
- Secrets appear in logs, URLs, persisted state, or UI errors.
- UI state claims completion before durable work succeeds.
- A feature flag hides UI but still registers tools or starts background work.
- A migration is destructive, non-idempotent, or incompatible with rollback.
- Tests assert implementation details while missing the user-visible invariant.

## Return the review

Lead with findings ordered by severity. Keep the summary short and place it after the findings. If no findings are supported, say so explicitly and list any validation gaps or untested areas. Do not claim the code is safe merely because compilation passes.
