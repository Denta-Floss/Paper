# Comparison Method

Use this method to compare implemented UI against a source design.

## 1. High-level pass

- Confirm component hierarchy and section order.
- Confirm top-level layout mode and scrolling behavior.

## 2. Component pass

For each visible component:

- presence and count
- position and alignment
- size and aspect ratio
- state and affordance

## 3. Visual property pass

- color values and opacity
- typography family, size, weight, and line height
- spacing, margins, and paddings
- border widths and corner radii
- shadows or elevation treatment

## 4. Responsive pass

- verify key breakpoints
- verify reflow behavior for dense sections
- verify clipping and overflow behavior

## 5. Prioritization

- `P0`: breaks UX or core layout contract
- `P1`: obvious mismatch users notice quickly
- `P2`: minor mismatch with low UX impact
