# URL To Code

Clone a live URL into a frontend-only local prototype after the design brief is confirmed.

## Safety Gate

Before capture or build, tell the user this workflow is only for sites they own or have permission
to recreate.

## Workflow

1. Open the URL with Browser tools.
2. Confirm the page is the intended page, not a login wall, error page, redirect, loading screen, or
   unrelated promo surface.
3. Capture desktop from top to bottom. Scroll in small steps and note sections, sticky elements,
   animations, lazy assets, controls, and state changes.
4. Capture mobile at `390 x 844`.
5. Use Browser content/snapshot tools to gather copy, controls, links, images, fonts, icons, colors,
   spacing, layout, and responsive behavior.
6. Test visible interactions one at a time and capture changed states.
7. Copy available assets locally. If an asset cannot be copied, generate a replacement with
   `ImageGenerate` using source screenshots as references; if an icon cannot be copied, use the
   closest open-source icon library.
8. Bootstrap the local prototype with `scripts/bootstrap-prototype.mjs`.
9. Build only from captured source evidence.
10. Run the local app, capture it in Browser, then run `design-qa`.

Do not hotlink source assets in the final app. Do not build from memory or generic approximations
when source evidence is available.
