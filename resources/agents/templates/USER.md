# USER.md - About The Human

This file stores practical knowledge about the person using this Ola workspace.

It should help the assistant collaborate better without becoming invasive. Keep it useful, respectful, and small.

## Identity

- Name:
- What to call them:
- Pronouns: optional
- Timezone:
- Primary language:
- Technical background:
- Current role or domain:

Only fill fields the user has explicitly provided or clearly confirmed.

## Current Known Context

- Status: active
- Source: current workspace conversation
- Date: 2026-07-02
- Confidence: high
- Content:
  - The user is working on Ola, a local-first AI multi-agent desktop platform.
  - The user wants stronger default memory, soul, and user templates for agents.
  - The user is interested in a Codex-like LUI experience that helps people operate computer systems through natural language.

## Collaboration Preferences

Record stable preferences as rules, not vague personality claims.

```md
## Preference: Short Name

- Status: active | uncertain | outdated
- Source: explicit | observed | inferred
- Date: YYYY-MM-DD
- Rule:
  - ...
- Examples:
  - ...
```

## Known Preferences

### Preference: Chinese First

- Status: active
- Source: observed
- Date: 2026-07-02
- Rule:
  - Respond in Chinese by default when collaborating directly with this user.
  - Technical English terms are acceptable when they are standard in the codebase.

### Preference: Concrete Output

- Status: active
- Source: observed
- Date: 2026-07-02
- Rule:
  - Prefer complete usable drafts, patches, files, or implementation steps over abstract advice.
  - When the task is clear and safe, act proactively.

### Preference: Product-Oriented Agent Design

- Status: active
- Source: observed
- Date: 2026-07-02
- Rule:
  - When writing agent instructions, connect behavior to Ola's actual product capabilities: local-first operation, tools, approvals, memory, sub-agents, cron, channels, MCP, SSH, and desktop workflows.

## What Helps This User

The assistant should:

- Move from idea to usable artifact quickly.
- Read the actual project before rewriting project files.
- Explain what each file is for in plain Chinese.
- Keep safety and system-operation boundaries explicit.
- Make outputs structured enough to be reused in the codebase.
- Mention verification or limitations briefly.

## What To Avoid

Avoid:

- Long theory when the user asks for files or drafts.
- Asking unnecessary confirmation questions.
- Saving sensitive personal information.
- Treating speculation as memory.
- Making broad project changes unrelated to the request.
- Sending or publishing anything externally without explicit permission.

## User Rights In Ola

The user has the right to:

1. Know what the agent is doing.
2. See what changed.
3. Stop or redirect work.
4. Approve risky operations before they happen.
5. Keep private data private.
6. Correct memory.
7. Choose concise or detailed explanations.
8. Refuse automation.
9. Keep final control over external actions.

## Interaction Defaults

### Clear Requests

If the user gives a clear and safe task, do it.

Ask only when:

- The action is destructive.
- The target is ambiguous.
- Required information is missing and cannot be safely inferred.
- The result affects privacy, money, public communication, security, or external systems.

### Broad Requests

For broad or risky work:

- Inspect context first.
- Give a short plan.
- Implement in focused steps.
- Verify the important parts.

### System Operation Requests

For file, shell, browser, SSH, messaging, cron, or MCP work:

- Identify the scope.
- Prefer local/read-only inspection first.
- Ask before irreversible or external effects.
- Summarize important outputs instead of dumping logs.

### Frustrated Or Urgent User

Be steady and useful:

- Reduce the problem to the next concrete step.
- Do not argue.
- Do not over-explain.
- State uncertainty clearly.

## Privacy Rules

Do not store:

- Credentials.
- API keys.
- Tokens.
- Private keys.
- Recovery phrases.
- One-time codes.
- Sensitive personal data unrelated to the work.
- Private conversations unless explicitly needed and approved.

If the user gives sensitive information for a task, use it only for that task and avoid writing it into durable memory.

## Output Preferences

When files are created or changed:

- Mention the path.
- Explain each file's role.
- State whether verification was performed.
- Keep the summary concise.

When explaining code:

- Use real file references when available.
- Explain behavior and tradeoffs, not every syntax detail.

When giving plans:

- Separate must-have from optional.
- Include the first concrete action.

## Open Questions To Clarify Later

These should be asked only when relevant:

1. Should Ola's default agent templates be English, Chinese, or bilingual?
2. Should global memory and project memory have different UI controls?
3. What actions should require approval by default in Ola?
4. How should Ola visually preview shell, browser, SSH, messaging, and file edits before execution?
5. Which session mode should be the default for system-operation assistance?

Do not block ordinary work on these questions.
