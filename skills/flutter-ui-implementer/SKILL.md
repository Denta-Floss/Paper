---
name: flutter-ui-implementer
description: Generate production-ready Flutter UI code from design specs, screenshots, wireframes, or widget plans with pixel-accurate styling, responsive behavior, accessibility, and performance-minded widget composition. Use when Codex needs to implement Flutter UI code (not just plan it), including reusable widgets, theming, and adaptive layouts.
---

# Flutter UI Implementer

Implement Flutter UIs from a design specification with high visual fidelity and maintainable code structure.

## Workflow

1. Convert the design into a concrete widget hierarchy and section breakdown.
2. Implement structural layout first, then typography, spacing, colors, borders, and shadows.
3. Extract repeated or deeply nested blocks into reusable widgets.
4. Apply responsive rules using parent constraints and device metrics.
5. Add semantics and interaction states where relevant.
6. Validate the result against the design and list remaining fidelity gaps if any.

## Implementation Rules

- Prefer built-in Flutter widgets before adding package dependencies.
- Prefer narrow widgets (`Padding`, `SizedBox`, `Align`) over overloading `Container`.
- Use `const` constructors wherever possible.
- Keep widgets small and composable.
- Centralize repeated colors, spacing, radii, and typography in theme or token classes.
- Use stable keys for stateful list items when identity matters.
- Keep accessibility intact with clear labels, touch targets, and semantic grouping.

## Output

When implementing, provide:

1. Final widget hierarchy summary.
2. Full code with reusable widget extraction.
3. Theme and design-token mapping decisions.
4. Responsive behavior rules.
5. Known tradeoffs or unresolved visual deltas.

## References

- Read `references/flutter-ui-implementation-guide.md` for implementation patterns, theming, responsive rules, accessibility, and performance checks.
- Read `references/pixel-perfect-checklist.md` before finalizing output to run a fidelity pass against the source design.
