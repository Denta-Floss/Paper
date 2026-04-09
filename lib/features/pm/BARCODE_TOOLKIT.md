# Barcode Toolkit

This module is the reusable home for barcode-related functionality that was first designed inside Inventory.

## Purpose

Keep the current Inventory barcode UX intact while making the underlying barcode building blocks easy to reuse later from other desktop features.

## What lives here

- `presentation/barcode/material_barcode_toolkit.dart`
  - `BarcodeTraceBadge`
  - `InlineBarcodePreview`
  - `ShowBarcodeButton`
  - `BarcodeSheetDialog`
  - `BarcodeSheetCard`
  - `buildMaterialBarcodeInfoRows()`

## Current consumers

- `features/inventory/presentation/screens/inventory_screen.dart`
- `features/inventory/presentation/screens/material_scan_screen.dart`

## Scope

This toolkit currently covers:

- desktop barcode preview
- desktop barcode sheet dialog
- scan trace badge
- shared material-detail rows for barcode results

The repository, save flow, and scan lookup logic still stay with Inventory because that is where the data lifecycle currently lives.

## Retrieval guidance

When another feature needs barcode UI:

1. import `features/pm/presentation/barcode/material_barcode_toolkit.dart`
2. reuse the shared widgets first
3. only add new barcode components here if they are feature-agnostic
4. keep feature-specific orchestration in that feature's own provider/screen

## Important rule

Do not change Inventory UX while extracting reusable code. Inventory is the reference implementation; PM is the toolkit home.
