# Flutter UI Implementation Guide

Use this reference when writing production UI code from a design spec.

## Implementation Sequence

1. Build scaffold and major sections.
2. Implement section-level layout.
3. Apply text hierarchy and spacing scale.
4. Apply colors, surfaces, borders, and shadows.
5. Add responsive adaptations.
6. Add semantics and interaction states.

## Composition Patterns

- Use `Scaffold` for page-level structure.
- Use `SingleChildScrollView` plus `Column` for vertically composed screens with mixed blocks.
- Use `ListView.builder` and `GridView.builder` for large dynamic collections.
- Use `CustomScrollView` plus slivers for pinned headers and mixed scrolling behavior.
- Use `Stack` only when overlap is intentional.

## Responsive Rules

- Use `LayoutBuilder` for parent-width-driven changes.
- Use `MediaQuery` for device-wide metrics and display features.
- Keep breakpoints explicit and deterministic.
- Prefer layout swaps over scaling every element proportionally.

## Theming and Tokens

- Use Material 3 theme as baseline when applicable.
- Move repeated values into tokens:
  - colors
  - spacing
  - radii
  - typography
  - elevation
- Avoid hardcoding repeated visual values across many widgets.

## Accessibility

- Provide semantic labels for icon-only actions.
- Keep tap targets comfortable on mobile.
- Preserve contrast for text and controls.
- Ensure focus order matches visual order.

## Performance

- Use `const` constructors whenever possible.
- Avoid unnecessary rebuilds by extracting stable subtrees.
- Use lazy list/grid builders for larger collections.
- Keep clip and opacity usage intentional; avoid expensive effects without need.
