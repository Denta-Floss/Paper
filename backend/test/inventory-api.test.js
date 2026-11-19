const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The materials side of inventory over HTTP, the routes inventory-sets-api,
// material-governance and barcode-ledger-events do not reach: child creation,
// edit, delete, linking to a group or an item, scan counts, the activity feed,
// the movements endpoint and the health summary.
//
// Written before the materials code left server.js. The ledger's finer rules
// (location moves, issue to a pipeline, over-issue guards) stay with
// barcode-ledger-events.test.js and integrity-safety.test.js.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function boot() {
  const tempDir = makeTempDir('paper-inventory-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'inventory@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'inventory@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  return {
    backend,
    server,
    baseUrl,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
  };
}

function api(ctx, method, route, body) {
  return fetch(`${ctx.baseUrl}${route}`, {
    method,
    headers: ctx.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function makeParent(ctx, extra = {}) {
  const res = await api(ctx, 'POST', '/api/materials/parent', {
    name: 'Test Sheet',
    type: 'Sheet',
    numberOfChildren: 2,
    unit: 'Kg',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.material;
}

test('materials: a parent is created with its children and read back', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const missing = await api(ctx, 'POST', '/api/materials/parent', { name: 'No type' });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /name, type, and numberOfChildren are required/);

  const parent = await makeParent(ctx);
  assert.equal(parent.kind, 'parent');
  assert.equal(parent.numberOfChildren, 2);
  assert.equal(parent.linkedChildBarcodes.length, 2);

  const one = await api(ctx, 'GET', `/api/materials/${parent.barcode}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.material.barcode, parent.barcode);
  assert.ok(one.body.groupConfiguration, 'a read carries the group configuration');

  assert.equal((await api(ctx, 'GET', '/api/materials/NOPE-0000')).status, 404);

  const list = await api(ctx, 'GET', '/api/materials');
  const barcodes = list.body.materials.map((m) => m.barcode);
  assert.ok(barcodes.includes(parent.barcode));
  for (const child of parent.linkedChildBarcodes) assert.ok(barcodes.includes(child));

  const detail = await api(ctx, 'GET', `/api/materials/${parent.barcode}/detail`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.material);
  assert.ok(detail.body.groupConfiguration);
  assert.equal((await api(ctx, 'GET', '/api/materials/NOPE-0000/detail')).status, 404);
});

test('materials: a child is added, the parent counts it, and it can be edited and deleted', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const parent = await makeParent(ctx, { numberOfChildren: 1 });

  assert.equal((await api(ctx, 'POST', `/api/materials/${parent.barcode}/child`, { name: ' ' })).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/materials/NOPE-0000/child', { name: 'Orphan' })).status, 500);

  const child = await api(ctx, 'POST', `/api/materials/${parent.barcode}/child`, { name: 'Extra Lot' });
  assert.equal(child.status, 201);
  assert.equal(child.body.material.kind, 'child');
  assert.equal(child.body.material.parentBarcode, parent.barcode);

  const reread = await api(ctx, 'GET', `/api/materials/${parent.barcode}`);
  assert.equal(reread.body.material.numberOfChildren, 2);

  assert.equal((await api(ctx, 'PATCH', `/api/materials/${child.body.material.barcode}`, { name: 'Only name' })).status, 400);
  const edited = await api(ctx, 'PATCH', `/api/materials/${child.body.material.barcode}`, {
    name: 'Renamed Lot',
    type: 'Sheet',
    grade: 'A',
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.material.name, 'Renamed Lot');
  assert.equal(edited.body.material.grade, 'A');
  assert.ok(edited.body.groupConfiguration);

  const gone = await api(ctx, 'DELETE', `/api/materials/${child.body.material.barcode}`);
  assert.equal(gone.status, 200);
  assert.equal((await api(ctx, 'GET', `/api/materials/${child.body.material.barcode}`)).status, 404);
  const parentAfter = await api(ctx, 'GET', `/api/materials/${parent.barcode}`);
  assert.equal(parentAfter.body.material.numberOfChildren, 1, 'deleting a child gives the parent its count back');

  const wholeFamily = await api(ctx, 'DELETE', `/api/materials/${parent.barcode}`);
  assert.equal(wholeFamily.status, 200);
  for (const b of parent.linkedChildBarcodes) {
    assert.equal((await api(ctx, 'GET', `/api/materials/${b}`)).status, 404, 'deleting a parent takes its children');
  }
});

test('materials: link to a group, link to an item, unlink, and the refusals', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const parent = await makeParent(ctx);
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  assert.ok(group, 'demo seed must provide a group');

  const toGroup = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/link-group`, { groupId: group.id });
  assert.equal(toGroup.status, 200);
  assert.equal(toGroup.body.material.linkedGroupId, group.id);

  const badGroup = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/link-group`, { groupId: 999999 });
  assert.equal(badGroup.status, 500);
  assert.match(badGroup.body.error, /Selected group is not available/);

  const noItem = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/link-item`, { itemId: 999999 });
  assert.equal(noItem.status, 500);
  assert.match(noItem.body.error, /Selected item is not available/);

  const unlinked = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/unlink`, {});
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.material.linkedGroupId, null);
  assert.equal(unlinked.body.material.linkedItemId, null);

  assert.equal((await api(ctx, 'PATCH', '/api/materials/NOPE-0000/unlink', {})).status, 500);

  const activity = await api(ctx, 'GET', `/api/materials/${parent.barcode}/activity`);
  assert.equal(activity.status, 200);
  const kinds = activity.body.events.map((e) => e.type);
  assert.ok(kinds.includes('linked'), 'linking is in the feed');
  assert.ok(kinds.includes('unlinked'), 'and so is unlinking');
});

test('materials: scans are counted, listed in the feed, and can be reset', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const parent = await makeParent(ctx);

  assert.equal((await api(ctx, 'PATCH', '/api/materials/NOPE-0000/scan', {})).status, 404);
  const first = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/scan`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.material.scanCount, 1);
  const second = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/scan`, {});
  assert.equal(second.body.material.scanCount, 2);
  assert.ok(second.body.material.lastScannedAt);

  assert.equal((await api(ctx, 'PATCH', '/api/materials/NOPE-0000/scan/reset', {})).status, 404);
  const reset = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/scan/reset`, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.material.scanCount, 0);
  assert.equal(reset.body.material.lastScannedAt, null);
  const history = await ctx.backend.get('SELECT COUNT(*) AS c FROM scan_history WHERE barcode = ?', [parent.barcode]);
  assert.equal(history.c, 0, 'the trace is cleared');
  const activity = await api(ctx, 'GET', `/api/materials/${parent.barcode}/activity`);
  assert.ok(activity.body.events.some((e) => e.type === 'scanReset'));
});

test('materials: group configuration is updated, and an unknown material is refused', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const parent = await makeParent(ctx);

  const updated = await api(ctx, 'PATCH', `/api/materials/${parent.barcode}/group-config`, {
    groupMode: 'standalone_group',
    inheritanceEnabled: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.material.groupMode, 'standalone_group');
  assert.equal(updated.body.material.inheritanceEnabled, true);
  assert.ok(updated.body.groupConfiguration);

  const ghost = await api(ctx, 'PATCH', '/api/materials/NOPE-0000/group-config', {});
  assert.equal(ghost.status, 500);
  assert.match(ghost.body.error, /Material not found/);
});

test('inventory: a movement over HTTP changes stock, shows in the activity feed, and an over-issue is refused', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const parent = await makeParent(ctx);

  const received = await api(ctx, 'POST', '/api/inventory/movements', {
    barcode: parent.barcode,
    movementType: 'receive',
    qty: 25,
    toLocationId: 'MAIN',
    // A receive has to say where the stock came from: a challan, or a manual
    // reference.
    referenceType: 'test-fixture',
    referenceId: 'seed-stock',
  });
  assert.equal(received.status, 201, JSON.stringify(received.body));
  assert.equal(received.body.success, true);
  assert.ok(received.body.material);

  const issued = await api(ctx, 'POST', '/api/inventory/movements', {
    barcode: parent.barcode,
    movementType: 'issue',
    qty: 10,
    fromLocationId: 'MAIN',
  });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));

  const stock = await api(ctx, 'GET', `/api/materials/${parent.barcode}`);
  assert.equal(stock.body.material.onHand, 15);

  const over = await api(ctx, 'POST', '/api/inventory/movements', {
    barcode: parent.barcode,
    movementType: 'issue',
    qty: 1000,
    fromLocationId: 'MAIN',
  });
  assert.ok(over.status >= 400, 'issuing more than is on hand is refused');
  assert.equal(over.body.success, false);
  const still = await api(ctx, 'GET', `/api/materials/${parent.barcode}`);
  assert.equal(still.body.material.onHand, 15, 'and nothing moved');

  const none = await api(ctx, 'POST', '/api/inventory/movements', { barcode: 'NOPE-0000', movementType: 'receive', qty: 1 });
  assert.ok(none.status >= 400);

  const detail = await api(ctx, 'GET', `/api/materials/${parent.barcode}/detail`);
  assert.equal(detail.status, 200);
});

test('inventory: the health summary answers', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const health = await api(ctx, 'GET', '/api/inventory/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.success, true);
  assert.equal(typeof health.body.health, 'object');
});

test('materials: two parents never share a barcode, even when the random part repeats', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  // A child's barcode is built from only the last part of its parent's, which
  // was four random digits. Two parents drawing the same four digits gave their
  // children the same barcodes, and the second create failed on the unique
  // index. It happened about once in a few hundred seeded databases.
  const realRandom = Math.random;
  t.after(() => { Math.random = realRandom; });

  Math.random = () => 0.5;
  const first = await api(ctx, 'POST', '/api/materials/parent', { name: 'Twin A', type: 'Sheet', numberOfChildren: 2, unit: 'Kg' });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  // The next create draws the same digits once, then real ones.
  let draws = 0;
  Math.random = () => { draws += 1; return draws === 1 ? 0.5 : realRandom(); };
  const second = await api(ctx, 'POST', '/api/materials/parent', { name: 'Twin B', type: 'Sheet', numberOfChildren: 2, unit: 'Kg' });
  Math.random = realRandom;
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const all = [first.body.material.barcode, ...first.body.material.linkedChildBarcodes,
    second.body.material.barcode, ...second.body.material.linkedChildBarcodes];
  assert.equal(new Set(all).size, all.length, 'six different barcodes');
});

