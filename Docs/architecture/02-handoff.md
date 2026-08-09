# Handoff — Kernel, Borders & Module Evacuation

> **Branch:** `infra/reconciler-and-borders` (30 commits ahead of `main`, pushed).
> **State:** green — `cd backend && npm test` → **68/68**.
> **Last verified:** 2026-08-09.
>
> [00-kernel-and-items-evacuation.md](00-kernel-and-items-evacuation.md) holds the
> original plan and running log. **This document is what you need to continue cold.**

---

## 1. Where things stand

| | |
|---|---|
| `backend/server.js` | **23,412 lines** (legacy remainder) |
| `backend/kernel/` | 3,537 lines / 12 files |
| `backend/modules/` | 4,934 lines / 24 files across **20 modules** |
| API routes | **203 module-claimed · 64 kernel · 0 unclaimed** |
| Tests | 28 files, **68 passing** |

**Routes: done. Services: barely started.** Every module has a `routes.js` and
`server.js` has **zero `/api` route registrations**. But the domain logic mostly
still lives in legacy and is handed to modules through a `ctx` object.

**The `ctx` count is the real progress meter** — it is the enumerated coupling to
the monolith, and it only goes down when a service moves:

```
challans 43 · items 31 · inventory 28 · orders 25 · people 20 · units 18
vendors 15 (service: 13) · clients 14 · machines 13 · dies 13 · pipelines 10
action_center 10 · production 7 · jobs 6 · portal 5 · payroll 5
company_profile 5 · search 4 · mobile 4 · freelancer_portal 3
```

Per-module completeness:

| Piece | Have it |
|---|---|
| `routes.js` | **20 / 20** |
| `ports.js` | 2 / 20 — items, challans |
| `contract.js` | 1 / 20 — items |
| `service.js` | **1 / 20 — vendors** |

`kernel/routes/` holds the non-business surface: `auth`, `users`, `assets`,
`track`, `favorites`, `sandbox`, `admin`, `introspection`.

---

## 2. The kernel constitution

Enforced by tests, not honour.

- **K1 — Inversion.** `kernel/registry.js` is the single source of module identity
  (labels, path segments, permission keys, record sources, Track labels, table
  ownership). Adding a module = one manifest entry.
- **K2 — Legacy freeze.** No new feature lands in legacy `server.js`.
- **K3 — Territory metering.** `kernel/territory.js` answers "how much is
  governed?" Unclaimed territory is a warning, not a norm.
- **K4 — One question, one border.** Identity → auth; module rights → the central
  gate; payload shape → the module contract; impossibility → DB constraints.
- **K5 — Ports only between modules.** A module never touches another's tables or
  helpers — it calls a named, metered port or a kernel seam.

---

## 3. The two playbooks

### 3a. Moving ROUTES (done for all 20 — kept for reference)

1. Route-surface snapshot must be green first.
2. **Locate routes by paren balancing**, not by scanning for a closing `});` — that
   heuristic found only 30 of challans' 52 routes.
3. Diff the extracted set against `test/fixtures/route-surface.json`: zero missing
   before touching `server.js`.
4. Move **verbatim**; do **not** re-indent (handlers contain multi-line SQL
   template literals); **preserve registration order** (Express matches in order —
   `/api/challan-templates/test-print` must precede `/api/challan-templates/:id`).
5. Compute `ctx` mechanically: identifiers used ∩ top-level declarations.
6. Register before the `/api` 404 catch-all. Late-bound values go in as thunks
   (`getIo: () => io`) — `io` is `null` until listen.
7. Verify: `node --check` → route-surface test byte-identical → `npm test` → live
   smoke on the moved endpoints.

### 3b. Moving a SERVICE (the current front — pattern proven on vendors)

1. **Locate the domain functions** for the module and measure their extents.
2. **Compute the service's dependencies** the same mechanical way. Vendors needed
   only 7: `get, all, run, logChange`, two string normalisers, and `challansPorts`.
3. Generate `modules/<name>/service.js` as
   `module.exports = function create<Name>Service(ctx) { … return { … } }` with the
   bodies **verbatim**. Dependencies are **injected, never imported**, so the file
   has no reach into the monolith.
4. In `server.js`, construct the service and **destructure its returns under the
   original names** — every legacy caller and the `module.exports` list keep
   working untouched.
5. **Placement matters.** Construct after any ports it needs and before the module's
   route registration. In the current file that window is roughly
   `challansPorts` (~22.7k) → route registrations (~22.8k) → `module.exports` (~23.4k).
6. **Expect the K5 guard-rail to fail here — that is the point.** The test only
   inspects `modules/`, so foreign-table reads that were invisible in legacy become
   violations the instant the code lands. Vendors' `getVendorPurchaseHistory` was
   querying `delivery_challans`/`delivery_challan_items`; it became
   `challans.reception.linesForVendor`.
7. Adding a port then trips "every declared port has a real implementation" until
   you update the ports test fixture. Both guards firing in sequence is normal.
8. Verify with `npm test` **plus a live smoke test** of the module's routes.

---

## 4. Hazards — read before touching anything

Each of these has already cost real time.

1. **`requirePermission('config.read'|'config.write')` does NOTHING.** Those keys are
   in `LEGACY_GUARD_PASSTHROUGH`; the guard calls `next()` immediately. A route
   whose only guard is `config.*` **and** whose segment has no manifest is entirely
   ungated. This exposed payroll salary data, and later allowed a proven
   **privilege escalation**: a user holding only `inventory.update` rewrote the
   company profile (`inventory.update` is one of the disjuncts in
   `requireApiWritePermission`).
2. **An undeclared path segment is ungated, not merely unmetered.** Creating
   `modules/<x>/routes.js` changes nothing about gating — only a registry manifest
   does.
3. **"Public" must hold at all THREE borders.** `requireAuth`, the module gate, and
   the legacy write gate. Bypassing auth for `/portal/login` while `portal` was also
   a declared CRUD module produced a 403 (the gate demanded `portal.create`, which
   an external client can never hold), then a second 403 from the write gate.
   Public paths are now declared once in the registry
   (`PUBLIC_API_PATHS` / `isPublicApiPath`) and honoured by all three.
4. **Bootstrap parity.** Fresh DBs build their schema in `initDb` and **never run the
   migration runner**. 15 tables from migrations 005/006 were missing from `initDb`,
   so the whole payroll and portal modules sat on non-existent tables and every one
   of their routes 500'd. **Adding a migration means adding the parity block.**
5. **SQLite has no nested transactions.** `saveItem` takes `{ useTransaction }`;
   `saveGroup` is transaction-free and must stay so.
6. **Synthetic negative variation ids.** The selector mints `-propertyId` for typed
   Gauge/Numeric values. They must be resolved **inside
   `normalizeDeliveryChallanItems`** — the downstream snapshot call passes only
   `(itemId, leafId)` and drops the path ids, so a fix anywhere else fails silently.
   Migration 027 triggers are the last line of defence.
7. **A contract must describe the system that exists.** An `inputType` enum the
   backend never enforced made items with a `'Dropdown'` property permanently
   un-editable. Contract guards are **log-only by default**; `PAPER_CONTRACT_ENFORCE=1`
   enables refusal deliberately.
8. **Express lets the FIRST duplicate registration win** — a half-finished move is
   invisible at runtime.

---

## 5. Testing lessons worth keeping

- **A green suite is not evidence for a query refactor.** When challans ports
  replaced embedded sub-SELECTs, nothing asserted those values; the equivalence test
  had to be written, with concrete expected numbers so it cannot pass vacuously on
  empty fixtures. An earlier probe reported "0 mismatches" while comparing nothing.
- **A test that invents its own fixture schema proves nothing.** The payroll test
  created a `payroll_components` table because none existed — with a
  `calculation_type` column the real schema doesn't have. It passed for days while
  the real routes were 500ing.
- **Mutation-test guard-rails.** The undefined-reference test was verified by
  reintroducing the bug and confirming it failed and named the line.
- **Verify consequences, don't infer them.** An analysis claimed the
  nested-transaction bug corrupts the caller's transaction; a runtime probe showed
  `saveItem`'s `BEGIN` sits outside its `try`, so the caller survives intact.

---

## 6. Open work, by value

1. **Continue service moves.** Suggested order: **inventory (28) → orders (25) →
   people (20) → units (18)**, leaving **challans (43)** last — its PDF engine,
   invoices and reconciliation are the most entangled. Each move will surface its
   own hidden K5 violations (that is the mechanism by which the guard-rail gets
   strong).
2. **Ports for the modules that need them** — emerges naturally from step 1, as
   each service move reveals its foreign reads.
3. **Contracts** — only items has one. Challan payloads are far more polymorphic:
   nearly every field accepts camelCase *and* snake_case *and* falls back to the
   existing row, so almost nothing may be `required`, and quantities are strings.
4. **Portal has no session model.** `/api/portal/catalog|cart|orders` identify the
   caller by a `client_id` **query parameter** with no verification. They are
   currently protected only because `portal` is a declared CRUD module, which also
   makes them unusable by real portal clients. Needs a decision.
5. **Reconciler v1** — `plan`/`apply`. v0 reports drift but never converges, so
   expand/collapse still isn't real.
6. **Fleet layer** — client manifests in git, wiring to `control-plane/` (Falcon
   View), canary rollout.

---

## 7. Commands

```bash
cd backend
npm test                                   # 68/68
node --test test/route-surface.test.js     # API surface unchanged
UPDATE_ROUTE_SNAPSHOT=1 npm test           # deliberately re-record the surface
PAPER_CONTRACT_ENFORCE=1 npm test          # contract guards in refusal mode
node --check server.js
```

**Guard-rails that encode the design — do not weaken them to make a change pass:**

- `test/kernel-k5-borders.test.js` — cross-module calls go through ports;
  `variation_stock` has exactly one writer; every declared port has a real
  implementation; **evacuated modules read only their own tables**; no table claimed
  twice; `server.js` declares no registry-owned maps.
- `test/route-surface.test.js` — the route snapshot, duplicate registrations,
  phantom segments.
- `test/undefined-references.test.js` — every `await name(...)` resolves.
- `test/payroll-authorization.test.js`, `test/company-profile-authorization.test.js` —
  the two authorization holes, pinned.
- `test/nested-transaction-safety.test.js`, `test/synthetic-leaf-normalization.test.js`,
  `test/challans-ports.test.js` — regression pins for §4 and §5.
