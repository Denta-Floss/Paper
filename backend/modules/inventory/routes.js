'use strict';

// ---------------------------------------------------------------------------
// Inventory over HTTP: the sets, the materials, and the movements.
//
//   GET    /api/inventory/sets        every set, with its lines and its group
//   POST   /api/inventory/sets        define one
//   PATCH  /api/inventory/sets/:id    change one (a full replace of its lines;
//                                     send expectedVersion to be refused if it
//                                     moved on, code set_changed)
//   DELETE /api/inventory/sets/:id    remove one and its links
//
//   GET    /api/materials                       every material
//   GET    /api/materials/:barcode              one, with its group configuration
//   GET    /api/materials/:barcode/detail       the control-tower read model
//   GET    /api/materials/:barcode/activity     its per-barcode feed
//   POST   /api/materials/parent                a parent and its children
//   POST   /api/materials/:barcode/child        one more child
//   PATCH  /api/materials/:barcode              edit
//   PATCH  /api/materials/:barcode/group-config governance
//   PATCH  /api/materials/:barcode/link-group   inherit from a group
//   PATCH  /api/materials/:barcode/link-item    inherit from an item and variation
//   PATCH  /api/materials/:barcode/unlink       stop inheriting
//   PATCH  /api/materials/:barcode/scan         count a scan
//   PATCH  /api/materials/:barcode/scan/reset   clear the trace
//   DELETE /api/materials/:barcode              remove it (a parent takes its children)
//   POST   /api/inventory/movements             receive, issue, transfer
//   GET    /api/inventory/health                the summary tiles
//   GET    /api/inventory/stock                 stock by item and variation
//
// `inventory` and `materials` are first path segments, so the central CRUD gate
// maps these to the inventory module.
//
// Every route asks the module's operations (./operations.js) at the kernel
// desk. The work is in ./work.js. A handler here names the operation, picks its
// input out of the request, writes the Track entries the work noted, and sends
// the result back as the answer the app has always had.
//
// NOT here: the universal barcode resolver and /api/scan, the search routes. See
// modules/inventory/service.js.
// ---------------------------------------------------------------------------

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerInventoryRoutes(ctx) {
  const { app, desk, requirePermission, cacheMasterData, trackCreate, trackUpdate, trackDelete } = ctx;
  const send = deskRoutes(desk, { create: trackCreate, update: trackUpdate, delete: trackDelete });

  app.get('/api/inventory/sets', requirePermission('inventory.read'),
    send('inventory.sets.list', (req) => ({ query: req.query })));

  app.post('/api/inventory/sets', requirePermission('inventory.create'),
    send('inventory.sets.create', (req) => ({ data: req.body })));

  app.patch('/api/inventory/sets/:id', requirePermission('inventory.update'),
    send('inventory.sets.update', (req) => ({ id: req.params.id, data: req.body })));

  app.delete('/api/inventory/sets/:id', requirePermission('inventory.delete'),
    send('inventory.sets.delete', (req) => ({ id: req.params.id, data: req.body })));

  app.get('/api/inventory/stock', requirePermission('inventory.read'),
    send('inventory.stock.list', (req) => ({ query: req.query })));

  app.get('/api/inventory/stock-sources', requirePermission('inventory.read'),
    send('inventory.stock.sources', (req) => ({ query: req.query })));

  app.get('/api/materials', requirePermission('inventory.read'), cacheMasterData,
    send('inventory.materials.list', (req) => ({ query: req.query })));

  app.get('/api/inventory/health', requirePermission('inventory.read'),
    send('inventory.health', (req) => ({ query: req.query })));

  app.get('/api/materials/:barcode', requirePermission('inventory.read'),
    send('inventory.materials.get', (req) => ({ barcode: req.params.barcode, query: req.query })));

  app.get('/api/materials/:barcode/detail', requirePermission('inventory.read'),
    send('inventory.materials.detail', (req) => ({ barcode: req.params.barcode, query: req.query })));

  app.post('/api/materials/parent', requirePermission('inventory.create'),
    send('inventory.materials.createParent', (req) => ({ data: req.body })));

  app.post('/api/materials/:barcode/child', requirePermission('inventory.create'),
    send('inventory.materials.createChild', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode', requirePermission('inventory.update'),
    send('inventory.materials.update', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/group-config', requirePermission('inventory.update'),
    send('inventory.materials.setGroupConfig', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.delete('/api/materials/:barcode', requirePermission('inventory.delete'),
    send('inventory.materials.delete', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/link-group', requirePermission('inventory.update'),
    send('inventory.materials.linkGroup', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/link-item', requirePermission('inventory.update'),
    send('inventory.materials.linkItem', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/unlink', requirePermission('inventory.update'),
    send('inventory.materials.unlink', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/scan', requirePermission('inventory.update'),
    send('inventory.materials.scan', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.patch('/api/materials/:barcode/scan/reset', requirePermission('inventory.update'),
    send('inventory.materials.resetScan', (req) => ({ barcode: req.params.barcode, data: req.body })));

  app.post('/api/inventory/movements', requirePermission('inventory.update'),
    send('inventory.movements.record', (req) => ({ data: req.body })));

  app.get('/api/materials/:barcode/activity', requirePermission('inventory.read'),
    send('inventory.materials.activity', (req) => ({ barcode: req.params.barcode, query: req.query })));
};
