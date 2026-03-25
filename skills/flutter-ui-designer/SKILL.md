---
name: flutter-ui-designer
description: Analyze screenshots, mockups, Figma exports, Material specs, and UI requirements and convert them into Flutter widget hierarchies, layout plans, design-token mappings, and responsive structure recommendations. Use when Codex needs to decide which Flutter widgets to use, how to compose them, how to map a design system into Flutter, or how to break a UI into reusable widgets before implementation.
---

# Flutter UI Designer

Turn visual designs and UI descriptions into an implementation-ready Flutter UI plan. Focus on widget selection, composition, layout strategy, theme mapping, and responsive behavior, not full code delivery.

## Workflow

1. Inspect the input artifact or description and identify the page scaffold, major sections, and scroll behavior.
2. Break each section into layout primitives before picking leaf widgets.
3. Map design elements to Flutter widgets that already exist in the framework before suggesting custom widgets or packages.
4. Extract design tokens into theme-level decisions when the same colors, type, spacing, or radii repeat.
5. Call out reusable custom widgets when repetition or deep nesting would hurt readability.
6. End with an implementation-oriented output the next coding pass can follow directly.

## Working Rules

- Prefer composition over complex custom widgets.
- Prefer built-in Flutter widgets over third-party packages unless the design clearly requires something Flutter does not provide.
- Use `Padding`, `SizedBox`, `Align`, `Expanded`, and `Flexible` intentionally instead of defaulting to `Container`.
- Treat responsiveness as part of the structure, not an afterthought.
- Keep recommendations aligned with the active design system: Material 3, Cupertino, or explicit custom tokens.
- Stay within planning scope. If the user needs production code, implementation, performance tuning, state management, or device orchestration, hand off to a more appropriate skill or proceed as a separate implementation task.

## Output

Provide these sections when analyzing a design:

1. High-level structure: scaffold type, scrolling model, major sections.
2. Widget hierarchy tree: an explicit tree that can be implemented directly.
3. Layout specifications: primary layout widgets, spacing, alignment, sizing constraints.
4. Design token mapping: colors, typography, spacing, radii, shadows, component states.
5. Custom widget recommendations: what to extract and why.
6. Responsive behavior: breakpoints, layout swaps, growth and shrink rules.
7. Complexity assessment: simple, medium, or complex, with main implementation risks.

## References

- Read `references/widget-selection-and-layout.md` when you need Flutter widget guidance, layout heuristics, responsive patterns, or design-system mapping.
- Read `references/design-analysis-and-output.md` when you need a structured review workflow, common screen patterns, or the expected output shape for design-analysis responses.
