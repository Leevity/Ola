# User Context

Use this for Product Design setup, saved design references, remembering preferences, or answering
what Product Design knows.

## Commands

Initialize context:

```bash
python3 {skill_root}/scripts/init_user_context.py
```

Read context:

```bash
python3 {skill_root}/scripts/user_context_preflight.py
```

## Save Policy

Save durable references only:

- product URLs
- Figma or design-system links
- screenshots and reference images
- codebase, Storybook, component, token, theme, or asset paths
- brand notes, icon sets, typography, browser/capture preference, share target

Do not save secrets, credentials, API keys, private tokens, or customer data.

For images, copy the file into `~/.ola/state/plugins/product-design/assets/` with a clear
name such as `checkout-mobile-error-state.png`.

Use this entry shape inside `user-context.md`:

```md
{reference title or URL}

- Date Added: YYYY-MM-DD.
- File: assets/name.png
- Useful Context: what this reference shows.
- Future Use: how future Product Design work should use it.
```

When no context exists and the user asks to get started, say Product Design can remember common
surfaces and sources, then ask them to send product URLs, Figma files, screenshots, codebase paths,
Storybook links, tokens, brand assets, or preferred share targets.
