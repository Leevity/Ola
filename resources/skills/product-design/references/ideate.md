# Ideate

Use this after the design brief is confirmed and the user needs visual directions or redesign
options.

## Workflow

1. Inspect provided or saved visual sources directly. Use `Read` for images and files; use Browser
   tools for live pages.
2. If a named source cannot be accessed, stop and ask whether to fix access or continue without it.
3. Choose target dimensions:
   - mobile app: `390 x 844`
   - tablet app: `834 x 1194`
   - desktop app, admin, or SaaS: `1440 x 1024`
   - landing page: `1440` wide and scrollable
   - component or modal: natural container size
   - provided visual source: match its aspect ratio when continuing that source
4. Use `ImageGenerate` to create exactly three independent options unless the user set another
   count. If a reference image is available, pass it through `reference_images`.
5. Give each concept a short memorable name and ask the user to choose one or keep exploring.

## Prompt Requirements

The prompt must ask for realistic production-quality UI with clear hierarchy, readable typography,
purposeful spacing, and constraints from the confirmed brief. Make the three options differ in
layout strategy, information hierarchy, interaction model, or product framing.

Do not put multiple concepts in one image. Do not build until the user chooses an option.
