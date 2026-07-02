---
name: product-design
description: Product Design workflow plugin for Ola. Use when the user mentions Product Design or asks to design, redesign, audit, research, prototype, clone a URL, turn an image or screenshot into code, generate UI directions, manage saved product design context, or share a runnable prototype.
---

# Product Design

Use this skill as a router for product-design work. It coordinates existing Ola tools:
`ImageGenerate`, `Browser*`, `Read`, `Write`, `Edit`, `Bash`, `WebSearch`, and any enabled MCP or
deployment tools.

Product Design is a workflow plugin, not a new privileged tool. Respect normal Ola file,
browser, shell, and approval behavior.

## Routing

Always pick the focused workflow and read its reference before acting:

- Setup, remember, or inspect saved product/design context: read `references/user-context.md`.
- Design, redesign, prototype, URL clone, image-to-code, or visual exploration: read
  `references/get-context.md` first.
- Generate visual directions: read `references/ideate.md`.
- Route coded prototype work: read `references/prototype.md`.
- Clone a live URL: read `references/url-to-code.md`.
- Build from a screenshot, mock, or generated option: read `references/image-to-code.md`.
- Audit a flow or screen: read `references/audit.md`.
- Research current user friction: read `references/research.md`.
- QA a built prototype against a source visual: read `references/design-qa.md`.
- Deploy or share a prototype: read `references/share.md`.

## Hard Rules

- Confirm a concise design brief before ideation or build work.
- A written brief is not a visual target. If there is no URL, screenshot, mockup, Figma frame,
  local running app, or selected generated option, generate visual directions first.
- Generate exactly three independent visual directions unless the user asks for a different count.
- Stop after showing visual directions and wait for the user to choose one before building.
- For URL cloning, warn that the user must own or have permission to recreate the target.
- Capture source evidence before building from URLs: desktop, mobile, content, assets, and states.
- For builds, create a frontend-only prototype unless the user explicitly asks to edit existing app
  source.
- Before handoff, run design QA and save `design-qa.md` in the prototype root. Hand off only when it
  says `final result: passed`; if comparison is blocked, write `final result: blocked`.

## Saved Context

Product Design context lives at:

```text
~/.ola/state/plugins/product-design/user-context.md
```

Assets saved for future runs live next to it:

```text
~/.ola/state/plugins/product-design/assets/
```

Run preflight before Product Design workflows when local shell access is available:

```bash
python3 {skill_root}/scripts/user_context_preflight.py
```

Use saved context as grounding, but the user's current source or instruction wins.

## Prototype Starter

Create new standalone prototypes with:

```bash
node {skill_root}/scripts/bootstrap-prototype.mjs --dest /absolute/path/to/prototype
```

Then run `npm install` in the prototype root and start the local Vite server when the route is ready.
Keep the dev server running and provide the local URL after QA passes.

## Communication

Talk like a design partner. Lead with the visible result, decision, or blocker. Keep updates short
and practical. Do not expose internal workflow names unless they help the user decide what happens
next.
