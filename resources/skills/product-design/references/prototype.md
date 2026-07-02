# Prototype

Use this to route coded prototype requests.

## Decision Rules

- New product idea without visual target: `get-context` -> `ideate` -> wait for selected option ->
  `image-to-code`.
- Redesign from image or screenshot: `get-context` -> `ideate` using the source image -> wait for
  selected option -> `image-to-code`.
- Recreate a live URL: `get-context` -> `url-to-code`.
- Recreate a provided image, screenshot, or selected generated option: `get-context` ->
  `image-to-code`.
- Add a feature to an existing local app: inspect the running app and code first, then edit the
  existing codebase using its design system.

Written direction alone is not enough to build from. If the user asks to "just build it" without a
visual target, generate and present visual directions first.

If the current folder already looks like a prototype and it is unclear whether to edit it or create
a fresh prototype, ask.
