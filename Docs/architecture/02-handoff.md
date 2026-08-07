# Handoff — Kernel, Borders & Module Evacuation

> **Branch:** `infra/reconciler-and-borders` (13 commits ahead of `main`, pushed).
> **State:** green — `cd backend && npm test` → **67/67**.
> **Last verified:** 2026-08-07.
>
> Read [00-kernel-and-items-evacuation.md](00-kernel-and-items-evacuation.md) for
> the original plan and the running log. This document is what you need to
> continue the work cold.

---

## 1. Where things stand

The monolith is being dissolved into module packages behind a thin kernel.

| | |
|---|---|
| `backend/server.js` | **27,611 lines** (the shrinking legacy tenant) |
| `backend/kernel/` | 1,132 lines — registry, contracts, territory, reconcile |
| `backend/modules/` | 1,568 lines — items, challans |
| Modules evacuated | **2 of 15** (items, challans) |
| API routes | 188 module-claimed · 64 kernel · **15 unclaimed** |
| Tests | 27 files, **67 tests, all passing** |

"Evacuated" currently means **the route registrations have moved**, not the
domain logic. Each module's `ctx` object is the precise, enumerated measure of
what is still coupled to legacy: **challans 43 entries, items 31**. Those
numbers should only ever go down.

### Unclaimed territory (the burn-down)

15 routes are served by no module manifest, so the central permission gate does
not gate them: `search` (4), `mobile` (4), `portal` (4), `company-profile` (2),
`freelancer-portal` (1). These are *deliberately* unclaimed — each needs an
ownership decision, not a mechanical claim. Note `/api/portal/login` sits behind
`requireAuth`, which looks like a chicken-and-egg problem worth verifying before
touching.

> **An undeclared path segment is ungated, not merely unmetered.** See §6.

---

## 2. The kernel constitution

Five rules the architecture is built on. They are enforced by tests, not honour.

- **K1 — Inversion.** The kernel owns module identity. `kernel/registry.js` is the
  single source: labels, UI grouping, path segments, CRUD/capability/fine
  permission keys, per-record grant sources, Track labels, asset guards, table
  ownership. Adding a module = one manifest entry.
- **K2 — Legacy freeze.** No new feature lands in the legacy region of
  `server.js`. New capability ⇒ new module, or an addition to an evacuated one.
- **K3 — Territory metering.** `kernel/territory.js` continuously answers "how
  much of the app is governed?" Unclaimed territory is a warning, not a norm.
- **K4 — One question, one border.** Identity → auth; module rights → the central
  gate reading the registry; payload shape → the module's contract;
  impossibility → DB constraints. No route-local permission logic.
- **K5 — Ports only between modules.** A module never touches another's tables or
  helpers. It calls a named, metered port, or a kernel-side seam.

---

## 3. What exists

### `backend/kernel/`

| File | Role |
|---|---|
| `registry.js` | Module manifests + all derived permission maps. **Consumed by server.js** — do not re-declare these maps anywhere else. |
| `contracts.js` | The one contract engine (`checkPayload`). Representation-tolerant by design: numeric strings coerce, `0/1` are booleans, `null` on an optional field is fine. Guards catch *structural impossibilities*, not JSON spelling. |
| `territory.js` | Claimed-vs-unclaimed meter over routes and tables; also feeds per-port call counts. |
| `reconcile.js` | **Reconciler v0** — drift report only, no convergence yet. |

### `backend/modules/`

- `items/` — `contract.js` (ingress + egress declarations), `ports.js` (11 ports,
  metered), `routes.js` (18 routes).
- `challans/` — `routes.js` (52 routes), `ports.js` (batch-shaped: delivered
  quantity by order item, challan counts by vendor). **No `contract.js` yet** —
  that is the next increment.

### Endpoints for operators (all admin-gated)

- `GET /api/kernel/territory` — claimed/unclaimed routes and tables, per-port traffic.
- `GET /api/kernel/reconcile` — drift report (see §5).
- `GET /api/kernel/guard-alerts` — persisted contract violations.

---

## 4. The evacuation playbook

This is the procedure that worked twice. Follow it exactly; the ordering is the
safety.

**Step 0 — Never skip: the route snapshot must be green first.**
```bash
cd backend && node --test test/route-surface.test.js
```

**Step 1 — Locate routes by paren balancing, not by eyeballing.**
Scan from each `app.method(` line and balance parentheses to find the block end.
A "stop at the closing `});`" heuristic found **only 30 of challans' 52 routes** —
it would have left 22 behind in a "finished" move.

**Step 2 — Diff the extracted set against the committed snapshot.**
`test/fixtures/route-surface.json` is ground truth. Extracted-vs-snapshot must
show **zero missing** before you touch `server.js`.

**Step 3 — Move verbatim.**
- No logic edits. A move and an edit never share a commit, so any regression can
  only be a wiring problem.
- **Do not re-indent.** Handlers contain multi-line SQL template literals;
  indenting changes the string contents.
- **Preserve registration order.** Express matches in order. Real example:
  `GET /api/challan-templates/test-print` must be registered *before*
  `/api/challan-templates/:id`, or the literal path is swallowed.

**Step 4 — Compute `ctx` mechanically.** Extract identifiers used in the moved
code, intersect with top-level declarations in `server.js`. That list is the
module's coupling, made visible.

**Step 5 — Register near the end of `server.js`** (beside the items/challans
registrations) but **before the `/api` 404 catch-all**. Late-bound values like
the socket server must be passed as thunks: `getIo: () => io` — `io` is `null`
until listen, so passing it by value hands over a permanent `null`.

**Step 6 — Verify, in this order.**
```bash
node --check server.js
node --test test/route-surface.test.js     # must be byte-identical
npm test                                    # 65/65
```
Then a live smoke test: boot the app and hit the moved endpoints for real.

**Step 7 — Mark `evacuated: true`** in the manifest and commit.

---

## 5. Reconciler v0 — what it does

`GET /api/kernel/reconcile` compares four declarations against four realities:

| Declared | Actual |
|---|---|
| registry manifests | routes mounted on the Express app |
| manifest `tables` | tables present in `sqlite_master` |
| manifest `evacuated` | `modules/<key>/` package on disk |
| `migrations/*.sql` | `_migrations` rows applied |
| `sandbox_client_configs` | registry module vocabulary |

It reports drift; it does **not** converge. v1 (`plan`/`apply`) is unbuilt.

A live finding worth knowing: fresh databases bootstrap their schema directly
and **never run the migration runner**, so `_migrations` is empty while 27
migration files exist. That is why `initDb` carries "bootstrap parity" blocks
mirroring recent migrations — **when you add a migration, add the parity block
too**, or fresh DBs and migrated DBs diverge. This exact gap once broke `main`.

---

## 6. Hazards — read before touching anything

These are real traps, each of which has already cost real time.

1. **`requirePermission('config.read'|'config.write')` does NOTHING.** Those keys
   are in `LEGACY_GUARD_PASSTHROUGH`; the guard returns `next()` immediately.
   Enforcement was moved to the central gate. So a route with only a `config.*`
   guard **whose path segment is not in a manifest** is completely ungated —
   `requireApiWritePermission` passes every GET. That combination exposed all
   payroll salary data to any logged-in user.
2. **SQLite has no nested transactions.** A helper that unconditionally opens one
   cannot be called from inside a caller's transaction. `saveItem` now takes
   `{ useTransaction }`; `saveGroup` is transaction-free and must stay that way.
3. **Synthetic negative variation ids.** The selector mints `-propertyId` for
   typed Gauge/Numeric values. They must be resolved to a real node **inside
   `normalizeDeliveryChallanItems`** — the downstream snapshot call passes only
   `(itemId, leafId)` and drops the path ids, so fixing it anywhere else fails
   silently. DB triggers (migration 027) are the last line of defence.
4. **A contract must describe the system that exists.** An `inputType` enum was
   added that the backend never enforced (the column is free text) while the
   desktop group editor emits `'Dropdown'`. With enforcement on, affected items
   became permanently un-editable. Contract guards are **log-only by default**;
   `PAPER_CONTRACT_ENFORCE=1` turns on refusal deliberately.
5. **Express lets the FIRST duplicate registration win.** A half-finished move is
   invisible at runtime — the old handler keeps serving while the new one looks
   live in source. The route-surface test forbids duplicates.
6. **A declared path segment that nothing serves gates nothing.** The jobs module
   declared `/api/jobs` while its routes lived at `/api/freelancer-jobs`.

---

## 7. Open work, roughly by value

**Finish what's started**
1. **Challans contract.** Ports now exist; the ingress contract does not.
   Note challan payloads are far more polymorphic than items': nearly
   every field accepts camelCase *and* snake_case *and* falls back to the
   existing row — so almost nothing may be marked `required`, and quantities are
   strings end-to-end.
2. **Shrink the ctx objects** by moving domain logic into `modules/*/service.js`
   (challans 43 → kernel facilities; items 31 → same).
3. `bom.lines` is the one port with zero callers — two live sites still query
   `item_bom_lines` directly.

**Then**
4. Third module. Inventory is heaviest (~33 items-territory reaches); a small
   master (vendors, units) is a quick win that further proves the playbook.
5. Decide ownership for the 15 unclaimed routes.
6. Reconciler v1: `plan`/`apply` — actual expand/collapse.
7. Fleet layer: client manifests in git, Falcon View (`control-plane/`) wiring.

**Known-good to leave alone**
- The items↔materials bridge (`ensureMaterialForItemSelection`) spans two
  territories; ownership is a deliberate open decision, not an oversight.

---

## 8. Bugs found and fixed on this branch

So they are not re-litigated. Each was verified at runtime, not just by reading.

| Bug | Impact |
|---|---|
| Payroll ungated | **Any authenticated user could read salary data** (proven: HTTP 200, `"value": 50000`) |
| Nested transaction in reconcile | In-use reconciliation failed whenever a bucket needed a new return item |
| `prepare()` undefined | `PUT /api/invoices/:id` always 500'd — invoices could never be edited |
| `handleAssetUploadComplete` undefined | Challan asset upload-complete always 500'd |
| `inputType` enum too strict | Items with a `'Dropdown'` property became permanently un-editable |
| Synthetic leaf regression | Typed-Gauge purchases could not be saved |
| Sheet weights dropped | Mobile sent per-sheet weights; the backend discarded them on every save |
| Registry orphaned | The permission gate and the territory meter read *different* maps |
| Two contract engines | The tested one was unused; the untested one enforced 400s |
| `stock.applyDelta` mis-wired | Pointed at a different function entirely (dormant, so latent) |
| Mis-declared table owners | `stage_reconciliations`, `piece_barcodes` |

One correction worth recording: an analysis claimed the nested-transaction bug
*corrupts* the caller's transaction. A runtime probe disproved it — `saveItem`'s
`BEGIN` sits outside its `try`, so it throws before any rollback handler runs and
the caller's transaction survives. **Verify consequences, don't infer them.**

---

## 9. Commands

```bash
cd backend
npm test                                   # 65/65
node --test test/route-surface.test.js     # API surface unchanged
UPDATE_ROUTE_SNAPSHOT=1 npm test           # deliberately re-record the surface
PAPER_CONTRACT_ENFORCE=1 npm test          # contract guards in refusal mode
node --check server.js
```

Guard-rail tests that encode the architecture (do not weaken these to make a
change pass — they are the design):

- `test/kernel-k5-borders.test.js` — cross-module calls go through ports;
  `variation_stock` has exactly one writer; every port has a real implementation;
  evacuated modules read only their own tables; no table claimed twice; server.js
  declares no registry-owned maps.
- `test/route-surface.test.js` — the 275-route snapshot, duplicate registrations,
  phantom segments.
- `test/undefined-references.test.js` — every `await name(...)` resolves.
- `test/nested-transaction-safety.test.js`, `test/synthetic-leaf-normalization.test.js`,
  `test/payroll-authorization.test.js` — regression pins for §6 and §8.
