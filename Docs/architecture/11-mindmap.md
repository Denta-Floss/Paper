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
      c4["⟳ Change 4: dies leave server.js"]
        c4a["7 routes moved, none left behind"]
        c4b["client link goes through late-bound link functions"]
        c4c["production port grows dieAssignedToActiveRun"]
        c4d["dies-api test added: 6 tests, 294 total"]
      c3["Change 3: machines leave server.js"]
      c2["Change 2: jobs leave server.js"]
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
      Machines evacuated
        mBiz["Business rules"]
          mb1["a machine number is the type initials plus the next in that type"]
          mb2["a taken number is refused by name and a free one is offered"]
          mb3["a save that does not mention a field keeps what is stored"]
          mb4["capacity kind is rated or free hand; only rated carries a figure"]
          mb5["a machine held by a live pipeline run cannot be deleted"]
        mApi["API surface"]
          ma1["GET /api/machines"]
          ma2["GET /api/machines/:id"]
          ma3["POST /api/machines, create or update"]
          ma4["DELETE /api/machines/:id"]
          ma5["GET /api/machines/:id/assets"]
          ma6["POST /api/machines/:id/assets/upload-intent and upload-complete"]
        mOrch["Orchestration: modules/machines/routes.js"]
          mo1["registerMachineRoutes ctx"]
          mo2["a refusal from the service becomes its status and body"]
          mo3["delete purges links and variations, late bound"]
        mSvc["Services: modules/machines/service.js"]
          ms1["createMachineService"]
          ms2["saveMachine, refusal or saved row"]
          ms3["listMachines, getMachine, deleteMachine"]
          ms4["rowToMachineDto, shared with orders report and trace"]
          ms5["machine-identity.js: buildMachineNo, nextMachineNo, nextFreeMachineNo"]
        mPort["Ports it uses"]
          mp1["production.machineAssignedToActiveRun"]
          mp2["assets kernel: listAssetsForEntity, createAssetUploadIntent, completeAssetUpload"]
        mData["Data"]
          md1["machines"]
        mTest["Tests"]
          mt1["machines-api.test.js"]
          mt2["machine-sheet-fields.test.js"]
        mLeft["Still in server.js"]
          ml1["GET /api/machines/:id/queue reads pipeline_runs"]
          ml2["direct SQL on machines from item save, barcode resolve, seeds, delete-request approve"]
      Dies ⟳ evacuated
        dBiz["Business rules"]
          db1["a die code is the type initials, then D, then the part code"]
          db2["a typed die type is allowed only with its label"]
          db3["a taken code is refused by name and a free one offered"]
          db4["a newly sent die maker must exist and not be archived"]
          db5["a die's client is a link, not a column; absent keeps it, null clears it"]
          db6["a die held by a live pipeline run cannot be deleted"]
          db7["a save that does not mention a field keeps what is stored"]
        dApi["API surface"]
          da1["GET /api/dies"]
          da2["GET /api/dies/:id"]
          da3["POST /api/dies, create or update"]
          da4["DELETE /api/dies/:id"]
          da5["GET /api/dies/:id/assets"]
          da6["POST /api/dies/:id/assets/upload-intent and upload-complete"]
        dOrch["Orchestration: modules/dies/routes.js"]
          do1["registerDieRoutes ctx"]
          do2["a refusal from the service becomes its status and body"]
          do3["delete purges links and variations, late bound"]
        dSvc["Services: modules/dies/service.js"]
          ds1["createDieService"]
          ds2["saveDie, refusal or saved row"]
          ds3["listDies, getDie, deleteDie, diesWithClients"]
          ds4["rowToDieDto, shared with orders report and trace"]
          ds5["dieJsonList, tolerant of free text in a JSON column"]
          ds6["die-identity.js: buildDieCode, nextFreeDieCode, isUsableDieType"]
          ds7["die-makers.js: the made-by master, already out"]
        dPort["Ports it uses"]
          dp1["production.dieAssignedToActiveRun ⟳ new"]
          dp2["links: resolveSoleEntityLinks and setSoleEntityLink, late bound"]
          dp3["assets kernel: listAssetsForEntity, createAssetUploadIntent, completeAssetUpload"]
        dData["Data"]
          dd1["dies, die_makers"]
        dTest["Tests"]
          dt1["dies-api.test.js"]
          dt2["die-sheet-fields.test.js"]
          dt3["die-makers.test.js"]
        dLeft["Still in server.js"]
          dl1["direct SQL on dies from item save, photo sync, barcode resolve, seeds, delete-request approve"]
      People legacy
        p1["departments, employees, login; payroll unclaimed by registry"]
        p2["people/ports.js: employeeIdByBarcode, read only"]
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
        pd2["⟳ production/ports.js: machineAssignedToActiveRun, dieAssignedToActiveRun, read only"]
      Jobs evacuated
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
          js5["syncAssemblyJob, called by production"]
          js6["propagateAssemblyRejection, called by reconciliation"]
        jPort["Ports it uses"]
          jp1["people.employeeIdByBarcode"]
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
| 3 | Machines leave `server.js`. Adds `modules/machines/{routes,service}.js` and `modules/production/ports.js`; delete asks production whether a live run holds the machine; orders report and trace keep the DTO via the service; adds `machines-api` test; registry `machines` evacuated. `/queue` deliberately stays. | API surface (unchanged paths), Orchestration, Services, Ports, Tests |
| 4 | Dies leave `server.js`. Adds `modules/dies/{routes,service}.js`; the production port gains `dieAssignedToActiveRun` (machines and dies share one helper); orders report and trace keep the DTO via the service; adds `dies-api` test; registry `dies` evacuated. | API surface (unchanged paths), Orchestration, Services, Ports, Tests |
