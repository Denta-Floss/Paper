const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// A module at function level: its work asked for by name at the kernel desk,
// with no request anywhere. Two things are pinned here.
//
//   1. A direct call and the HTTP route reach the SAME operation — asked the
//      same thing they give the same answer.
//   2. The borders hold: a module is refused what it has not declared, a user
//      what they have no permission for, and nobody outside gets an internal
//      operation.
//
// The desk's own rules are in kernel-desk.test.js; this file is the real
// backend with the real operations registered.

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
  const tempDir = makeTempDir('paper-function-level-');
  const dbPath = path.join(tempDir, 'paper.db');
  process.env.DB_PATH = dbPath;
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'function@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'function@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  return {
    backend,
    desk: backend.desk,
    server,
    baseUrl,
    dbPath,
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

const system = { actor: { kind: 'system' } };

async function orderInput(ctx, orderNo) {
  const client = (await api(ctx, 'POST', '/api/clients', { name: `Client for ${orderNo}` })).body.client;
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name: `Item for ${orderNo}`,
    alias: '',
    displayName: `Item for ${orderNo}`,
    groupId: group.id,
    unitId: unit.id,
    variationTree: [],
  });
  return {
    orderNo,
    clientId: client.id,
    itemId: item.id,
    variationLeafNodeId: 0,
    variationPathNodeIds: [],
    quantity: 10,
    status: 'notStarted',
  };
}

test('the desk offers both converted modules, and records who may ask whom', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const names = ctx.desk.catalogue().map((operation) => operation.name);
  for (const name of [
    'process_routes.stages.list',
    'process_routes.routes.save',
    'orders.list',
    'orders.get',
    'orders.save',
    'orders.edit',
    'orders.lifecycle.set',
    'orders.delete',
    'orders.clients.lockedLineCount',
    'orders.lines.idsForOrderNo',
  ]) {
    assert.ok(names.includes(name), `${name} should be on offer`);
  }

  const uses = ctx.desk.declaredUses();
  assert.ok(uses.clients.includes('orders.clients.lockedLineCount'));
  assert.ok(uses.production.includes('orders.lines.idsForOrderNo'));
  assert.ok(uses.inventory.includes('orders.lines.customVariationValues'));
});

test('an order line lives its whole life through the desk, and HTTP sees the same line', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const saved = await ctx.desk.call('orders.save', await orderInput(ctx, 'FN-1'), system);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.merged, false);
  const id = saved.order.id;

  // The same line through both doors.
  const viaDesk = await ctx.desk.call('orders.get', { id }, system);
  const viaHttp = await api(ctx, 'GET', `/api/orders/${id}`);
  assert.deepEqual(viaHttp.body.order, JSON.parse(JSON.stringify(viaDesk.order)));

  // The same list through both doors.
  const listDesk = await ctx.desk.call('orders.list', {}, system);
  const listHttp = await api(ctx, 'GET', '/api/orders');
  assert.deepEqual(listHttp.body.orders, JSON.parse(JSON.stringify(listDesk.orders)));
  assert.equal(listHttp.body.total, listDesk.total);
  assert.equal(listDesk.hasMore, false);

  // A list filter given as a list, and as the comma text a query string sends.
  const asList = await ctx.desk.call('orders.list', { ids: [id] }, system);
  const asText = await ctx.desk.call('orders.list', { ids: String(id) }, system);
  assert.deepEqual(asList.orders.map((o) => o.id), [id]);
  assert.deepEqual(asText.orders.map((o) => o.id), [id]);

  const moved = await ctx.desk.call('orders.lifecycle.set', { id, status: 'inProgress' }, system);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.order.status, 'inProgress');

  // A refusal the service throws comes back as a result, not as a throw.
  const jump = await ctx.desk.call('orders.lifecycle.set', { id, status: 'draft' }, system);
  assert.equal(jump.ok, false);
  assert.equal(jump.status, 400);
  assert.match(jump.error, /Invalid lifecycle transition/);

  const edited = await ctx.desk.call('orders.edit', { id, quantity: 25 }, system);
  assert.equal(edited.ok, true);
  assert.equal(edited.order.quantity, 25);
  assert.equal((await api(ctx, 'GET', `/api/orders/${id}`)).body.order.quantity, 25);

  const missing = await ctx.desk.call('orders.edit', { id: 999999, quantity: 1 }, system);
  assert.deepEqual(missing, { ok: false, status: 404, error: 'Order not found.' });

  const gone = await ctx.desk.call('orders.delete', { id }, system);
  assert.deepEqual(gone, { ok: true, recoveredMovements: [] });
  assert.equal((await api(ctx, 'GET', `/api/orders/${id}`)).status, 404);
  assert.deepEqual(await ctx.desk.call('orders.get', { id }, system), {
    ok: false,
    status: 404,
    error: 'Order not found.',
  });

  // The territory meter counts what each operation served, whichever door.
  const territory = (await api(ctx, 'GET', '/api/kernel/territory')).body.territory;
  const served = territory.modules.orders.runtime.operationCalls;
  assert.ok(served['orders.get'] >= 4, JSON.stringify(served));
  assert.equal(served['orders.delete'], 1);
});

test('one module asks another only for what it has declared', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const input = await orderInput(ctx, 'FN-2');
  const saved = await ctx.desk.call('orders.save', input, system);
  await ctx.desk.call('orders.lifecycle.set', { id: saved.order.id, status: 'inProgress' }, system);

  // Clients has declared these, and gets the answers the client master shows.
  const clients = ctx.desk.as('clients');
  assert.equal((await clients.ask('orders.clients.lineCount', { clientId: input.clientId })).count, 1);
  assert.equal(
    (await clients.ask('orders.clients.lockedLineCount', { clientId: input.clientId })).count,
    1,
  );
  assert.equal((await clients.ask('orders.clients.lineCounts')).counts[input.clientId], 1);

  // …and the client master, which asks through that handle, shows the count.
  const listed = await api(ctx, 'GET', '/api/clients');
  const row = listed.body.clients.find((client) => client.id === input.clientId);
  assert.equal(row.usageCount ?? row.usage_count, 1);

  // Production has declared the line reads, not the client counts.
  const production = ctx.desk.as('production');
  assert.deepEqual(
    (await production.ask('orders.lines.idsForOrderNo', { orderNo: 'FN-2' })).ids,
    [saved.order.id],
  );
  const refused = await production.call('orders.clients.lineCount', { clientId: input.clientId });
  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'not_declared');

  // No module may delete an order just because it can reach the desk.
  assert.equal((await clients.call('orders.delete', { id: saved.order.id })).code, 'not_declared');
});

test('a user is held to the operation’s permission, and never gets an internal one', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const nobody = { kind: 'user', user: { id: 99, role: 'user' }, permissions: {} };
  const reader = { kind: 'user', user: { id: 99, role: 'user' }, permissions: { 'orders.read': true } };
  const owner = { kind: 'user', user: { id: 1, role: 'super_admin' }, permissions: {} };

  assert.equal((await ctx.desk.call('orders.list', {}, { actor: nobody })).code, 'forbidden');
  assert.equal((await ctx.desk.call('orders.list', {}, { actor: reader })).ok, true);
  assert.equal((await ctx.desk.call('orders.delete', { id: 1 }, { actor: reader })).code, 'forbidden');

  // What the central /api gate already let this request through for — a
  // per-record grant, say — is not refused a second time. Only that exact key.
  const granted = { ...nobody, cleared: 'orders.read' };
  assert.equal((await ctx.desk.call('orders.list', {}, { actor: granted })).ok, true);
  assert.equal((await ctx.desk.call('orders.delete', { id: 1 }, { actor: granted })).code, 'forbidden');

  const internal = await ctx.desk.call('orders.clients.lineCounts', {}, { actor: owner });
  assert.equal(internal.code, 'operation_internal');
});

test('process routes answer the same through the desk as over HTTP', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const viaDesk = await ctx.desk.call('process_routes.stages.list', {}, system);
  const viaHttp = await api(ctx, 'GET', '/api/process-stages');
  assert.ok(viaDesk.stages.length > 0);
  assert.deepEqual(viaHttp.body.stages, JSON.parse(JSON.stringify(viaDesk.stages)));

  const made = await ctx.desk.call('process_routes.stages.create', { name: 'Deburr' }, system);
  assert.equal(made.ok, true);
  const again = await api(ctx, 'POST', '/api/process-stages', { name: 'deburr' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'stage_exists');
  assert.equal(again.body.stage.id, made.stage.id);

  const noPart = await ctx.desk.call('process_routes.routes.list', { partId: 999999 }, system);
  assert.deepEqual(noPart, { ok: false, status: 404, error: 'That part no longer exists.' });
});
