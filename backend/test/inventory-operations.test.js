const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ASKS = require('../modules/inventory/asks');
const { inventoryClient } = require('../modules/inventory/client');
const { createInventoryPorts } = require('../modules/inventory/ports');
const { makeTempDir } = require('./helpers/temp-dir');

// Inventory behind the kernel desk.
//
// inventory-api, inventory-sets-api, challan-stock-bridge, run-stock-inputs
// and the journey tests pin every HTTP answer and every stock figure; they
// passed unchanged. This file pins what is new:
//
//   1. a route's answer and Track entry survive the trip through an operation;
//   2. the client other modules are handed is the ports, shape for shape, and
//      every call on it is a desk call held to what the caller declared;
//   3. two operations can never share a name (they did, briefly: production
//      asking to apply a movement was answered by the user's operation).

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = makeTempDir('paper-inventory-ops-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'stock@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stock@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { backend, desk: backend.desk, server, api };
}

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const sheet = (name) => ({ name, type: 'Sheet', numberOfChildren: 2, unit: 'Kg' });

test('the client is the ports, shape for shape, and nothing has two names', () => {
  const ports = createInventoryPorts({ inventory: {}, getMaterialRowByBarcode: () => null });
  const client = inventoryClient({ ask: async () => ({ value: null }) });

  const shape = (object) =>
    Object.fromEntries(Object.entries(object).map(([group, fns]) => [group, Object.keys(fns).sort()]));
  assert.deepEqual(shape(client), shape(ports), 'every port is in asks.js, and nothing else is');

  const names = ASKS.map((ask) => ask.as || ask.port);
  assert.equal(new Set(names).size, names.length, 'no two asks share an operation name');
});

test('the client turns a port call into the named operation with named arguments', async () => {
  const asked = [];
  const client = inventoryClient({
    ask: async (name, input) => {
      asked.push([name, input]);
      return { ok: true, value: 'answer' };
    },
  });
  assert.equal(await client.movements.applyCore({ qty: 2 }, { useTransaction: false }), 'answer');
  await client.receipts.retire('MAT-1', '2026-11-19');
  await client.materials.delete('MAT-2');
  await client.sets.membershipForItem(7);
  assert.deepEqual(asked, [
    ['inventory.movements.applyCore', { movement: { qty: 2 }, options: { useTransaction: false } }],
    ['inventory.receipts.retire', { barcode: 'MAT-1', now: '2026-11-19' }],
    // Named apart from the user's inventory.materials.delete.
    ['inventory.materials.deleteRecord', { barcode: 'MAT-2' }],
    ['inventory.sets.membershipForItem', { itemId: 7 }],
  ]);
});

test('a material is the same through the desk and over HTTP, and its Track entry is still written', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  // Over HTTP: the answer carries no `track`, and Track has the entry.
  const made = await ctx.api('POST', '/api/materials/parent', sheet('Desk Sheet'));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal('track' in made.body, false, 'track is for the route, not for the app');
  const barcode = made.body.material.barcode;
  // Track is fire-and-forget; give it a moment to land.
  let logged = null;
  for (let attempt = 0; attempt < 40 && !logged; attempt += 1) {
    logged = await ctx.backend.get(
      "SELECT * FROM entity_activity_log WHERE entity_type = 'materials' AND action = 'created' ORDER BY id DESC LIMIT 1",
    );
    if (!logged) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(logged, 'creating a material over HTTP still writes a Track entry');

  // Through the desk: the same material, and the entry it would have written
  // is on the result for whoever is in a position to write it.
  const viaDesk = await ctx.desk.call('inventory.materials.createParent', { data: sheet('Desk Sheet 2') }, system);
  assert.equal(viaDesk.ok, true, JSON.stringify(viaDesk));
  assert.equal(viaDesk.httpStatus, 201);
  assert.equal(viaDesk.track[0][0], 'create');
  assert.equal(viaDesk.track[0][1], 'materials');

  const oneHttp = await ctx.api('GET', `/api/materials/${barcode}`);
  const oneDesk = await ctx.desk.call('inventory.materials.get', { barcode }, system);
  assert.deepEqual(oneHttp.body.material, plain(oneDesk.material));
  assert.deepEqual(oneHttp.body.groupConfiguration, plain(oneDesk.groupConfiguration));

  const listHttp = await ctx.api('GET', '/api/materials');
  const listDesk = await ctx.desk.call('inventory.materials.list', {}, system);
  assert.deepEqual(listHttp.body.materials, plain(listDesk.materials));

  // A refusal keeps its status and its words.
  const bad = await ctx.desk.call('inventory.materials.createParent', { data: { name: 'No type' } }, system);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.match(bad.error, /name, type, and numberOfChildren are required/);
  const missing = await ctx.api('GET', '/api/materials/NO-SUCH-BARCODE');
  const missingDesk = await ctx.desk.call('inventory.materials.get', { barcode: 'NO-SUCH-BARCODE' }, system);
  assert.equal(missing.status, missingDesk.status);
  assert.equal(missing.body.error, missingDesk.error);
});

test('a movement asked by a module is not the user’s operation, and joins the caller’s transaction', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  // The user's, behind POST /api/inventory/movements…
  assert.equal(listed['inventory.movements.record'].internal, false);
  assert.equal(listed['inventory.movements.record'].permission, 'inventory.update');
  // …and the two other modules ask for.
  assert.equal(listed['inventory.movements.apply'].internal, true);
  assert.equal(listed['inventory.movements.applyCore'].internal, true);
  assert.equal(listed['inventory.movements.applyCore'].joinsCallerTransaction, true);
  assert.deepEqual(listed['inventory.movements.applyCore'].usedBy, ['challans', 'jobs', 'orders', 'production']);
  assert.equal(listed['inventory.receipts.mintFromChallanLine'].joinsCallerTransaction, true);

  // Production receives stock through the client; the ledger shows it.
  const material = (await ctx.api('POST', '/api/materials/parent', sheet('Moved Sheet'))).body.material;
  const forProduction = inventoryClient(ctx.desk.as('production'));
  const row = await forProduction.materials.rowByBarcode(material.barcode);
  assert.equal(row.barcode, material.barcode);
  await forProduction.movements.apply({
    barcode: material.barcode, movementType: 'receive', qty: 5, actor: 'Test', toLocationId: 'MAIN',
    referenceType: 'test-fixture', referenceId: 'seed-stock',
  });
  const after = await ctx.api('GET', `/api/materials/${material.barcode}`);
  assert.equal(after.body.material.onHand, 5, JSON.stringify(after.body.material));

  // A refusal the service throws reaches the caller as the error it was.
  await assert.rejects(
    forProduction.movements.apply({ barcode: material.barcode }),
    /barcode, movementType, and qty \(> 0\) are required/,
  );

  // A module that has not declared it is refused, by name.
  await assert.rejects(
    inventoryClient(ctx.desk.as('clients')).movements.apply({ barcode: material.barcode, movementType: 'receive', qty: 1 }),
    (error) => error.code === 'not_declared',
  );
  await assert.rejects(
    inventoryClient(ctx.desk.as('orders')).receipts.mintLot({}),
    (error) => error.code === 'not_declared',
  );

  // And inventory asks its own neighbours, for what it declared.
  assert.equal((await ctx.desk.as('inventory').ask('orders.items.demand', { itemId: 999999 })).lines, 0);
  assert.deepEqual((await ctx.desk.as('inventory').ask('challans.rows.brief', { ids: [] })).rows, []);
  assert.equal((await ctx.desk.as('inventory').call('clients.rows.get', { id: 1 })).code, 'not_declared');

  const broken = Object.entries(ctx.desk.violationCounts()).filter(([name]) => name.startsWith('inventory.'));
  assert.deepEqual(broken, []);
});
