---
name: flutter-ui-comparison
description: Compare Flutter implementation screenshots against source designs and produce an actionable pixel-fidelity discrepancy report across layout, spacing, typography, color, borders, and component states. Use when Codex needs validation feedback and exact fix recommendations for design-to-code accuracy.
---

# Flutter UI Comparison

Validate implemented Flutter screens against design references and return precise discrepancy findings with fix guidance.

## Workflow

1. Compare high-level structure and section ordering.
2. Compare component presence, positions, and dimensions.
3. Check typography, color, spacing, radii, and shadows.
4. Assign priority based on visual impact and UX risk.
5. Produce fix recommendations mapped to likely widget/theme changes.

## Output

Return findings grouped by severity:

1. Critical mismatches that break layout or UX.
2. High-visibility styling mismatches.
3. Minor polish deltas.

For each finding include:

- what differs
- expected value or behavior
- likely Flutter-level fix direction

## References

- Read `references/comparison-method.md` for the structured analysis flow.
- Read `references/discrepancy-report-template.md` for the final response format.
