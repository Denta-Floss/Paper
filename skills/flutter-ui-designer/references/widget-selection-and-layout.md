# Widget Selection and Layout

Use this reference when selecting Flutter widgets, designing section layout, or mapping design tokens into Flutter structure.

## Selection Rules

- Prefer composition over monolithic custom widgets.
- Prefer built-in widgets over packages.
- Use `const` constructors whenever the final implementation allows it.
- Reach for the narrowest widget that solves the problem.
  - Use `Padding` for padding only.
  - Use `SizedBox` for fixed gaps or fixed dimensions.
  - Use `Align` or `Center` for positioning.
  - Use `Container` when multiple concerns need to be combined: decoration, padding, constraints, transforms, or margins.

## Layout Decision Guide

### Single-child structure

- `Padding`: add inset spacing.
- `SizedBox`: add fixed width, fixed height, or spacer gaps.
- `Align`: anchor a child to a specific edge or corner.
- `Center`: center a child in available space.
- `AspectRatio`: preserve image, media, or card proportions.
- `ConstrainedBox` or `SizedBox`: enforce min or max dimensions when the design depends on strict sizing.

### Multi-child structure

- `Row`: horizontal sequences, toolbars, metadata rows.
- `Column`: vertical page sections, forms, stacked content blocks.
- `Stack`: overlays, floating badges, hero headers, image plus controls.
- `Wrap`: chips, tags, compact flowing controls.
- `ListView`: scrollable linear content.
- `GridView`: card grids or image galleries.
- `CustomScrollView`: mixed sliver layouts, sticky headers, expanding app bars, complex scroll effects.

### Space distribution

- `Expanded`: child must consume remaining free space.
- `Flexible`: child may share free space but can remain smaller than the maximum.
- Fixed-size children plus one `Expanded` child usually produce more stable layouts than multiple unconstrained children in the same `Row`.

## Constraint Heuristics

Flutter layout follows three rules:

1. Constraints go down.
2. Sizes go up.
3. Parents position children.

Use those rules to reason about failures:

- Overflow in a `Row` usually means too many unconstrained children want more width than exists.
- A child not filling width usually means the parent did not pass tight horizontal constraints.
- Deeply nested containers often hide the real sizing intent; simplify the tree before debugging.

## Responsive Patterns

- Use `LayoutBuilder` when the decision depends on available width from the parent.
- Use `MediaQuery` when the decision depends on screen metrics, orientation, or display features.
- Use `OrientationBuilder` only when the branching logic is specifically portrait versus landscape.
- Switch layout structure at clear breakpoints.
  - Phone: mostly single-column flow.
  - Tablet: two-pane or wider grids when content density supports it.
  - Foldable or split layouts: account for `displayFeatures` and avoid placing critical controls under a hinge or fold.

Common responsive moves:

- Convert `Column` sections into `Row` or two-pane layouts on larger widths.
- Increase grid columns rather than stretching cards indefinitely.
- Cap readable text width with constraints instead of allowing full-bleed text blocks on large screens.

## Design System Mapping

### Material 3

- Use `ThemeData(useMaterial3: true)` for Material 3 work.
- Prefer Material 3 navigation and action widgets when the design matches them.
  - `NavigationBar` instead of legacy `BottomNavigationBar`.
  - `NavigationDrawer` instead of older drawer patterns when appropriate.
  - `FilledButton`, `OutlinedButton`, `TextButton`, and `IconButton` according to emphasis.
- Map repeated colors and text styles into `ColorScheme` and `TextTheme` before recommending local overrides everywhere.

### Custom tokens

When the design does not map cleanly to stock Material or Cupertino values, define reusable tokens:

- Colors
- Typography
- Spacing
- Radii
- Elevation or shadows

Recommend token classes or theme extensions when the same values repeat across components.

## Extraction Rules

Recommend custom widgets when any of these are true:

- The same component pattern appears in multiple places.
- The widget tree becomes difficult to read because of deep nesting.
- A section has its own visual contract, such as `ProductCard`, `ProfileHeader`, or `ActionToolbar`.
- The UI needs a stable boundary for future state or interaction logic.

Do not extract tiny one-off wrappers unless they improve clarity materially.
