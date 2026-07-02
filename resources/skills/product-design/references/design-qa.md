# Design QA

Use this before every Product Design build handoff. It compares a source visual target against a
rendered implementation.

## Required Evidence

- source visual target path or URL
- implementation screenshot path or URL
- viewport and state
- full-view comparison evidence
- focused region comparison evidence, or why it was unnecessary

Open or capture both artifacts before judging. Do not QA from memory or code alone.

## Compare

Check:

- typography: family, weight, scale, line height, wrapping, hierarchy
- spacing and layout rhythm: margins, gaps, alignment, padding, radii, shadows, density
- colors and tokens: palette, gradients, opacity, contrast, semantic states
- image and asset fidelity: subject, crop, scale, quality, transparency, icon style
- copy and product text
- interactions and states
- responsiveness at the requested viewport and at least one alternate viewport when relevant
- accessibility basics: contrast risks, focus, labels, keyboard reachability, reduced motion

## Report Format

Write `design-qa.md` in the prototype root:

```md
**Findings**
- [P1] Title
  Location: ...
  Evidence: source does X, implementation does Y.
  Impact: ...
  Fix: ...

**Open Questions**
- ...

**Implementation Checklist**
- ...

**Follow-up Polish**
- ...

source visual truth path:
implementation screenshot path:
viewport:
state:
full-view comparison evidence:
focused region comparison evidence:
patches made since previous QA:
final result: passed
```

Use `final result: passed` only when no actionable P0/P1/P2 remains. Use
`final result: blocked` when comparison is impossible or P0/P1/P2 remains.
