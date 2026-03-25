# Discrepancy Report Template

Use this response shape when reporting findings.

## Summary

- Fidelity score estimate (optional)
- Total findings by priority

## Findings

For each finding:

- `priority`: P0, P1, or P2
- `area`: layout, typography, color, spacing, border, shadow, state
- `difference`: what currently differs
- `expected`: what should match the design
- `fix direction`: Flutter-level adjustment to apply

## Suggested Fix Order

1. Structural and spacing issues first.
2. Typography and color alignment second.
3. Border, shadow, and polish updates last.
