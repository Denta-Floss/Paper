'use strict';

// ---------------------------------------------------------------------------
// Items module — HTTP routes (evacuation step 1: routes moved VERBATIM from
// server.js; no logic edits — reviewability rule from the evacuation plan).
//
// Domain logic (saveItem, saveGroup, DTOs, usage queries) still lives in
// legacy server.js and arrives via ctx — it evacuates in the next step, when
// modules/items/service.js takes it over and the remaining ctx shrinks to
// kernel facilities only.
// ---------------------------------------------------------------------------
//
// Every route asks the module's operations (./operations.js) at the kernel
// desk; the work is in ./work.js. A handler names the operation, picks its
// input out of the request, writes the Track entries the work noted, and sends
// the result back as the answer the app has always had. The guards in front of
// each route are the ones it always had, the payload contract included.

const contracts = require('./contract');
const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerItemsModuleRoutes(ctx) {
  const {
    app,
    desk,
    requirePermission,
    requireAssetEntityPermission,
    cacheMasterData,
    guardContract,
    trackCreate,
    trackUpdate,
    trackDelete,
  } = ctx;
  const send = deskRoutes(desk, { create: trackCreate, update: trackUpdate, delete: trackDelete });
  // A part's photos are guarded as its attachments.
  const partPhotos = () => 'item';

  app.get('/api/groups', requirePermission('config.read'), cacheMasterData,
    send('items.groups.list', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/items/:id/assets/upload-intent', requirePermission('config.write'),
    send('items.assets.uploadIntent', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/items/:id/assets/upload-complete', requirePermission('config.write'),
    send('items.assets.uploadComplete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/items/:id/assets', requirePermission('config.read'),
    send('items.assets.list', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/items/:id/photos', requireAssetEntityPermission('read', partPhotos),
    send('items.photos.list', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/items/:id/photos', requireAssetEntityPermission('write', partPhotos),
    send('items.photos.arrange', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/items/:id/sets', requirePermission('config.read'),
    send('items.sets', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/items/:id/usage', requirePermission('config.read'),
    send('items.usage', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/items', requirePermission('config.read'), cacheMasterData,
    send('items.list', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/items/next-part-identity', requirePermission('config.read'),
    send('items.nextPartIdentity', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/items/:id', requirePermission('config.read'),
    send('items.get', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/items/:id/short-code', requirePermission('config.write'),
    send('items.setShortCode', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/items', requirePermission('config.write'), guardContract(contracts.itemWrite),
    send('items.create', (req) => ({ query: req.query, data: req.body })));

  app.patch('/api/items/:id', requirePermission('config.write'), guardContract(contracts.itemWrite),
    send('items.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/items/:id/section-tree', requirePermission('config.write'),
    send('items.setSectionTree', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/items/:id/archive', requirePermission('config.write'),
    send('items.archive', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/items/:id', requirePermission('config.write'),
    send('items.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/items/:id/group', requirePermission('config.write'),
    send('items.moveToGroup', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/groups', requirePermission('config.write'), guardContract(contracts.groupWrite),
    send('items.groups.create', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/groups/:groupId/items', requirePermission('config.write'),
    send('items.groups.addItems', (req) => ({ groupId: req.params.groupId, query: req.query, data: req.body })));

  app.get('/api/groups/:groupId/items', requirePermission('config.read'),
    send('items.groups.items', (req) => ({ groupId: req.params.groupId, query: req.query, data: req.body })));

  app.patch('/api/groups/:id', requirePermission('config.write'), guardContract(contracts.groupWrite),
    send('items.groups.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/groups/:id/archive', requirePermission('config.write'),
    send('items.groups.archive', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/groups/:id/unarchive', requirePermission('config.write'),
    send('items.groups.unarchive', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/groups/:id', requirePermission('config.write'),
    send('items.groups.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/groups/:id/schema-impact', requirePermission('config.read'),
    send('items.groups.schemaImpact', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/groups/:id/overview', requirePermission('config.read'),
    send('items.groups.overview', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/groups/:id/effective-schema', requirePermission('config.read'),
    send('items.groups.effectiveSchema', (req) => ({ id: req.params.id, query: req.query, data: req.body })));
};
