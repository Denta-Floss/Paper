# Design Analysis and Output

Use this reference when reviewing a screenshot, mockup, Figma export, or written UI spec and turning it into an implementation-ready Flutter plan.

## Analysis Workflow

### 1. High-level structure

Identify:

- Page scaffold type
- Top app chrome and bottom navigation needs
- Scroll model
  - full-page scroll
  - fixed header with scrolling body
  - nested scroll or sliver-based behavior
- Major sections and their order

### 2. Section breakdown

For each section, identify:

- Primary layout primitive: `Row`, `Column`, `Stack`, `Wrap`, list, grid
- Alignment and spacing pattern
- Whether the section is reusable
- Whether the section has fixed or content-driven height

### 3. Component identification

List the visible UI elements and map them to likely Flutter widgets:

- text
- images
- icons
- buttons
- chips
- cards
- list items
- forms
- navigation controls

If the same component repeats, recommend a custom widget abstraction.

### 4. Styling analysis

Capture:

- dominant and accent colors
- text hierarchy
- spacing rhythm
- corner radii
- borders
- shadows
- backgrounds and surfaces

Decide whether those values should live in theme configuration or in local widget styling.

### 5. Responsive considerations

Call out:

- likely breakpoint changes
- sections that should reflow
- components that need width caps
- grids that should change column count
- behavior changes for tablets or foldables

### 6. Delivery format

End with an implementation plan another coding pass can use immediately.

## Common Screen Patterns

### App bars and top chrome

- Standard app pages: `Scaffold` plus `AppBar`
- Large media or hero headers: `SliverAppBar` or `Stack`
- Transparent app bars over imagery: `Stack` with positioned top chrome

### Lists and collections

- Long linear content: `ListView.builder`
- Sectioned lists: `ListView` with grouped widgets or slivers
- Dense card browsing: `GridView.builder`
- Mixed static and scroll content: `CustomScrollView`

### Forms

- Use `Form` with `TextFormField` when validation matters.
- Keep spacing regular and validation messages predictable.
- Group related controls into clear vertical sections.

## Response Template

Use this structure in the final analysis:

1. High-level structure
2. Widget hierarchy tree
3. Layout specifications
4. Design token mapping
5. Custom widget recommendations
6. Responsive behavior
7. Complexity assessment

Example hierarchy shape:

```text
Scaffold
├── AppBar
│   └── Text
└── Body
    └── SingleChildScrollView
        └── Column
            ├── HeroHeader
            │   └── Stack
            ├── ContentSection
            │   └── ListView.builder
            └── FooterActions
                └── Row
```

## Scope Boundaries

This skill is for analysis and planning. It does not need to provide:

- full production implementation
- state-management architecture
- performance tuning
- testing strategy
- simulator or device orchestration

If the user still needs those, preserve the analysis and continue in a separate implementation step.
