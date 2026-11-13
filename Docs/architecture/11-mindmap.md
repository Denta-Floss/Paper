# 11 · Backend mind map

One map of the backend, updated with every change. It reads from the business
down to the code: each module breaks into what the business needs from it, the
API it exposes, the handlers that serve it, the service functions behind those,
the ports it shares with other modules, the tables it owns and the tests that
pin it.

Nodes touched by the latest change carry **⟳**. Modules that have left
`server.js` say `evacuated`; the rest say `legacy`. Only the modules that have
been through a change are expanded; the others show what the registry knows.

Source of truth for module identity is `backend/kernel/registry.js`; this map
is what a person reads first, the registry is what the server reads.

## Layers, top to bottom

| Layer | Question it answers | Where it lives |
|---|---|---|
| Business rules | What must always be true? | service functions, guards |
| API surface | What can a client ask? | `modules/<name>/routes.js` |
| Orchestration | Which steps run for one request? | route handlers, `register<Name>Routes(ctx)` |
| Services | What are the reusable operations? | `modules/<name>/service.js` |
| Ports | What may another module ask of this one? | `modules/<name>/ports.js` |
| Data | What is stored? | tables in `registry.js` |
| Tests | What pins the behaviour? | `backend/test/*.test.js` |

## The map

```mermaid
mindmap
  root((Paper backend))
    Latest change
      c1["⟳ Change 1: vendors leave server.js"]
        c1a["6 routes, 5 service functions, 1 DTO moved"]
        c1b["party-kit shared by clients and vendors"]
        c1c["first challans port, read only"]
        c1d["route-surface test added: 370 routes pinned"]
    Kernel
      k1["registry.js: 15 modules, permissions, Track labels"]
      k2["territory.js: meters routes and tables per module"]
      k3["contracts.js, barcodes.js, event-logger.js"]
    Masters
      Vendors ⟳ evacuated
        vBiz["Business rules"]
          vb1["one vendor per name or GST number"]
          vb2["a vendor named on a challan cannot be deleted"]
          vb3["absent logo or photo keeps what is stored"]
          vb4["name is required"]
        vApi["API surface"]
          va1["GET /api/vendors"]
          va2["GET /api/vendors/:id"]
          va3["GET /api/vendors/:id/purchase-history"]
          va4["POST /api/vendors"]
          va5["PATCH /api/vendors/:id"]
          va6["DELETE /api/vendors/:id"]
        vOrch["Orchestration: modules/vendors/routes.js"]
          vo1["registerVendorRoutes ctx"]
          vo2["emit vendor_added, vendor_updated, vendor_deleted"]
          vo3["trackCreate, trackUpdate, trackDelete"]
        vSvc["Services: modules/vendors/service.js"]
          vs1["createVendorService"]
          vs2["saveVendor"]
          vs3["findVendorDuplicate"]
          vs4["getVendorRowById, getVendorsWithUsage"]
          vs5["rowToVendorDto"]
        vKit["Shared kit: modules/parties/party-kit.js"]
          vk1["normalizePartyValue, normalizeGstNumber"]
          vk2["createPartyDeleteBlockers"]
        vPort["Ports it uses"]
          vp1["challans.vendorUsageCount"]
          vp2["challans.vendorUsageCounts"]
          vp3["challans.vendorPurchaseRows"]
          vp4["itemsPorts.describe"]
        vData["Data"]
          vd1["vendors"]
        vTest["Tests"]
          vt1["vendors-api.test.js"]
          vt2["route-surface.test.js"]
        vLeft["Still in server.js"]
          vl1["ensureFullSeedVendor and scenario seeders"]
          vl2["delete-request approve: DELETE FROM vendors"]
          vl3["getVendorForChallan in the challan code"]
      Items evacuated
        i1["modules/items: routes, ports, contract, master-data, section-tree"]
      Units evacuated
        u1["modules/units: families and seed only; CRUD routes still legacy"]
      Process routes evacuated
        pr1["modules/process_routes: routes, service"]
      Clients legacy
        cl1["15 routes in three clusters plus 4 portal routes"]
        cl2["next: reuses party-kit"]
      Machines legacy
        m1["8 routes; /queue reads pipeline_runs"]
      Dies legacy
        d1["7 routes; die-makers already in modules/dies"]
      People legacy
        p1["departments, employees, login; payroll unclaimed by registry"]
      Pipelines legacy
        pl1["templates at the app root bypass the /api gate"]
    Flows
      Orders legacy
        o1["18 core routes, 13 tables"]
      Inventory legacy
        iv1["22 routes, 13 tables, ledger writes"]
      Challans legacy
        ch1["about 26 endpoints, each served twice, 14 tables"]
        ch2["⟳ challans ports file created, vendor reads only"]
      Production legacy
        pd1["runs, node-status, scrap; touches everything"]
      Jobs legacy
        j1["6 freelancer routes, 3 tables"]
      Action center legacy
        ac1["trash, delete-requests dispatcher, integrity scan"]
```

## Change log

| # | Change | Layers touched |
|---|---|---|
| 1 | Vendors leave `server.js`. Adds `modules/vendors/{routes,service}.js`, `modules/parties/party-kit.js`, `modules/challans/ports.js`; adds `vendors-api` and `route-surface` tests; registry flag `evacuated: true`. | API surface (unchanged paths), Orchestration, Services, Ports, Tests |
