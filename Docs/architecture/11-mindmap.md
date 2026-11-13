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
      c2["⟳ Change 2: jobs leave server.js"]
        c2a["6 routes, 9 service functions moved"]
        c2b["production now calls jobs.syncAssemblyJob"]
        c2c["first people port, read only"]
        c2d["jobs-api test added: 4 tests, 284 total"]
      c1["Change 1: vendors leave server.js"]
    Kernel
      k1["registry.js: 15 modules, permissions, Track labels"]
      k2["territory.js: meters routes and tables per module"]
      k3["contracts.js, barcodes.js, event-logger.js"]
    Masters
      Vendors evacuated
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
        p2["⟳ people/ports.js: employeeIdByBarcode, read only"]
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
      Jobs ⟳ evacuated
        jBiz["Business rules"]
          jb1["one assembly job per run and node, never duplicated"]
          jb2["a re-synced job is only rewritten while unassigned"]
          jb3["handing a job to a worker issues its assembled set from stock"]
          jb4["scrap booked at reconciliation mirrors onto the job as rejections"]
        jApi["API surface"]
          ja1["GET /api/freelancer-jobs"]
          ja2["POST /api/freelancer-jobs"]
          ja3["POST /api/freelancer-jobs/batches"]
          ja4["PUT /api/freelancer-jobs/:id"]
          ja5["DELETE /api/freelancer-jobs/:id"]
          ja6["GET /api/freelancer-portal/data"]
        jOrch["Orchestration: modules/jobs/routes.js"]
          jo1["registerJobsRoutes ctx"]
          jo2["decrypt worker token, find employee, return their card"]
          jo3["delete rolls back on failure"]
        jSvc["Services: modules/jobs/service.js"]
          js1["createJobsService"]
          js2["createJob, createBatch, setStatus, deleteJob"]
          js3["listAll, dataForFreelancer"]
          js4["issueAssemblySetsForJobs"]
          js5["syncAssemblyJob ⟳ called by production"]
          js6["propagateAssemblyRejection ⟳ called by reconciliation"]
        jPort["Ports it uses"]
          jp1["people.employeeIdByBarcode ⟳ new"]
          jp2["inventory.getMaterialRowByBarcode, applyInventoryMovementCore"]
        jData["Data"]
          jd1["freelancer_jobs, freelancer_job_batches, freelancer_job_tasks"]
        jTest["Tests"]
          jt1["jobs-api.test.js"]
          jt2["assembly-job-dedupe.test.js"]
        jLeft["Still in server.js"]
          jl1["worker token secret is a literal in routes.js, to be fixed"]
          jl2["freelancer-* not in the inline gate map, legacy write gate only"]
          jl3["production picks the job's item, then hands it to syncAssemblyJob"]
      Action center legacy
        ac1["trash, delete-requests dispatcher, integrity scan"]
```

## Change log

| # | Change | Layers touched |
|---|---|---|
| 1 | Vendors leave `server.js`. Adds `modules/vendors/{routes,service}.js`, `modules/parties/party-kit.js`, `modules/challans/ports.js`; adds `vendors-api` and `route-surface` tests; registry flag `evacuated: true`. | API surface (unchanged paths), Orchestration, Services, Ports, Tests |
| 2 | Jobs leave `server.js`. Adds `modules/jobs/{routes,service}.js` and `modules/people/ports.js`; production's job write and reconciliation's rejection mirror now call the jobs service; adds `jobs-api` test; registry: jobs `evacuated: true` plus its real path segments (meter only). | API surface (unchanged paths), Orchestration, Services, Ports, Tests |
