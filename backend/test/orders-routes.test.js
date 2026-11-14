const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The order routes nothing else reaches over HTTP: PO uploads and documents,
// material requirements, status history, lifecycle, edit, delete, the runs of an
// order, its returns and its trace. Creating and listing are pinned by
// orders-api and wire-weight; fulfilment, reconciliation and the production
// report have their own files.
//
// Written before the orders code left server.js, and it pins the oddities as
// they are: an edit answers with a raw database row, a delete of an order that is
// not there answers success, and documents for an unknown order are an empty
// list rather than a 404.

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-orders-routes-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'orders@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'orders@example.test', password: 'OwnerPass1234' }),
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

async function simpleItem(ctx, name) {
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name, alias: '', displayName: name, groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return item.id;
}

async function makeOrder(ctx, orderNo, extra = {}) {
  const client = extra.clientId
    ? { id: extra.clientId }
    : (await api(ctx, 'POST', '/api/clients', { name: `Client for ${orderNo}` })).body.client;
  const itemId = extra.itemId || await simpleItem(ctx, `Item for ${orderNo}`);
  const res = await api(ctx, 'POST', '/api/orders', {
    orderNo,
    clientId: client.id,
    itemId,
    variationLeafNodeId: 0,
    variationPathNodeIds: [],
    quantity: 10,
    status: 'notStarted',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { order: res.body.order, clientId: client.id, itemId };
}

test('orders: lifecycle moves along allowed steps, records history, and refuses a jump', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { order } = await makeOrder(ctx, 'RT-LIFE-1');

  const started = await api(ctx, 'PATCH', `/api/orders/${order.id}/lifecycle`, { status: 'inProgress' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.order.status, 'inProgress');

  const jump = await api(ctx, 'PATCH', `/api/orders/${order.id}/lifecycle`, { status: 'draft' });
  assert.ok(jump.status >= 400 && jump.status < 500, `in progress cannot go back to draft (got ${jump.status})`);
  assert.equal(jump.body.order, null);

  const ghost = await api(ctx, 'PATCH', '/api/orders/999999/lifecycle', { status: 'inProgress' });
  assert.ok(ghost.status >= 400);

  const history = await api(ctx, 'GET', `/api/orders/${order.id}/status-history`);
  assert.equal(history.status, 200);
  assert.ok(history.body.history.length >= 1);
  assert.ok(history.body.history.some((h) => JSON.stringify(h).includes('inProgress')));

  const activity = await api(ctx, 'GET', `/api/orders/${order.id}/activity`);
  assert.equal(activity.status, 200);
  assert.ok(activity.body.activities.length >= 1);

  // History and activity DO say 404 for an order that is not there (PO
  // documents, below, do not).
  const none = await api(ctx, 'GET', '/api/orders/999999/status-history');
  assert.equal(none.status, 404);
  assert.deepEqual(none.body.history, []);
  assert.equal((await api(ctx, 'GET', '/api/orders/999999/activity')).status, 404);
});

test('orders: an edit changes the line and answers with the raw row', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { order } = await makeOrder(ctx, 'RT-EDIT-1');

  const edited = await api(ctx, 'PUT', `/api/orders/${order.id}`, { quantity: 25, unitPrice: 3.5 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  // The oddity: this is the database row (snake_case), not the DTO every other
  // order route returns.
  assert.equal(edited.body.order.quantity, 25);
  assert.equal(edited.body.order.unit_price, 3.5);
  assert.equal(edited.body.order.order_no, 'RT-EDIT-1');
  assert.equal(edited.body.order.orderNo, undefined);

  const other = (await api(ctx, 'POST', '/api/clients', { name: 'Second Client', alias: 'SEC' })).body.client;
  const moved = await api(ctx, 'PUT', `/api/orders/${order.id}`, { clientId: other.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.order.client_id, other.id);
  assert.equal(moved.body.order.client_name, 'Second Client', 'the name follows the client');
  assert.equal(moved.body.order.client_code, 'SEC', 'and the code is its alias');
  const header = await ctx.backend.get('SELECT client_id FROM order_headers WHERE order_no = ?', ['RT-EDIT-1']);
  assert.equal(header.client_id, other.id);

  const missing = await api(ctx, 'PUT', '/api/orders/999999', { quantity: 1 });
  assert.equal(missing.status, 404);
});

test('orders: material requirements are stored with the line and read back as rows', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { order } = await makeOrder(ctx, 'RT-REQ-1');

  const empty = await api(ctx, 'GET', `/api/orders/${order.id}/material-requirements`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.requirements, []);

  const now = new Date().toISOString();
  await ctx.backend.run('PRAGMA foreign_keys = OFF');
  const cols = (await ctx.backend.all('PRAGMA table_info(order_material_requirements)')).map((c) => c.name);
  assert.ok(cols.includes('order_id'));
  const required = (await ctx.backend.all('PRAGMA table_info(order_material_requirements)'))
    .filter((c) => c.notnull && c.dflt_value === null && c.name !== 'id');
  const names = required.map((c) => c.name);
  const values = required.map((c) => (c.name === 'order_id' ? order.id : (/_at$/.test(c.name) ? now : (/INT|REAL|NUM/i.test(c.type) ? 1 : 'x'))));
  await ctx.backend.run(
    `INSERT INTO order_material_requirements (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    values,
  );
  const one = await api(ctx, 'GET', `/api/orders/${order.id}/material-requirements`);
  assert.equal(one.body.requirements.length, 1);
  assert.equal(one.body.requirements[0].order_id, order.id, 'rows come back as stored, snake_case');
});

test('orders: PO documents of an unknown order are an empty list, and a bad upload is refused', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { order } = await makeOrder(ctx, 'RT-PO-1');

  const none = await api(ctx, 'GET', `/api/orders/${order.id}/po-documents`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.documents, []);
  const ghost = await api(ctx, 'GET', '/api/orders/999999/po-documents');
  assert.equal(ghost.status, 200, 'not a 404');
  assert.deepEqual(ghost.body.documents, []);

  const badIntent = await api(ctx, 'POST', '/api/order-po-uploads/intent', {});
  assert.ok(badIntent.status >= 400);
  assert.equal(badIntent.body.intent, null);
  const badComplete = await api(ctx, 'POST', '/api/order-po-uploads/complete', {});
  assert.ok(badComplete.status >= 400);
  assert.equal(badComplete.body.document, null);

  const badLink = await api(ctx, 'POST', `/api/orders/${order.id}/po-documents`, { documentIds: [999999] });
  assert.ok(badLink.status >= 400, 'a document that was never uploaded cannot be linked');
  const noLink = await api(ctx, 'POST', `/api/orders/${order.id}/po-documents`, { documentIds: [] });
  assert.equal(noLink.status, 200);
  assert.deepEqual(noLink.body.documents, []);

  const badRead = await api(ctx, 'POST', '/api/order-po-documents/999999/read-url', {});
  assert.ok(badRead.status >= 400);
  assert.equal(badRead.body.readUrl, null);
});

test('orders: deleting a line removes what hangs off it, and the header with the last line', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const first = await makeOrder(ctx, 'RT-DEL-1');
  const secondItem = await simpleItem(ctx, 'Second line item');
  const second = await makeOrder(ctx, 'RT-DEL-1', { clientId: first.clientId, itemId: secondItem });
  assert.notEqual(first.order.id, second.order.id);
  await api(ctx, 'PATCH', `/api/orders/${first.order.id}/lifecycle`, { status: 'inProgress' });

  const gone = await api(ctx, 'DELETE', `/api/orders/${first.order.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body.recoveredMovements, []);
  assert.equal(await ctx.backend.get('SELECT id FROM order_items WHERE id = ?', [first.order.id]), undefined);
  for (const table of ['order_status_history', 'order_activity_log']) {
    const left = await ctx.backend.get(`SELECT COUNT(*) AS c FROM ${table} WHERE order_id = ?`, [first.order.id]);
    assert.equal(left.c, 0, `${table} is cleared`);
  }
  assert.ok(await ctx.backend.get("SELECT order_no FROM order_headers WHERE order_no = 'RT-DEL-1'"), 'the header stays while a line remains');

  assert.equal((await api(ctx, 'DELETE', `/api/orders/${second.order.id}`)).status, 200);
  assert.equal(await ctx.backend.get("SELECT order_no FROM order_headers WHERE order_no = 'RT-DEL-1'"), undefined, 'and goes with the last one');

  // The oddity: there is nothing to delete, and it still says success.
  const ghost = await api(ctx, 'DELETE', '/api/orders/999999');
  assert.equal(ghost.status, 200);
  assert.equal(ghost.body.success, true);
});

test('orders: deleting a line dissolves its run and puts consumed stock back', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { order } = await makeOrder(ctx, 'RT-DEL-2');
  const material = (await api(ctx, 'POST', '/api/materials/parent', { name: 'Run Sheet', type: 'Sheet', numberOfChildren: 0, unit: 'Kg' })).body.material;
  await api(ctx, 'POST', '/api/inventory/movements', {
    barcode: material.barcode, movementType: 'receive', qty: 20, toLocationId: 'MAIN',
    referenceType: 'test-fixture', referenceId: 'seed',
  });

  const now = new Date().toISOString();
  await ctx.backend.run('PRAGMA foreign_keys = OFF');
  await ctx.backend.run(
    `INSERT INTO pipeline_runs (id, template_id, template_version, name, status) VALUES ('run-ord-1', 'tpl-x', 1, 'Run', 'in_progress')`,
  );
  const opaCols = (await ctx.backend.all('PRAGMA table_info(order_pipeline_assignments)'))
    .filter((c) => c.notnull && c.dflt_value === null && c.name !== 'id');
  const opaNames = opaCols.map((c) => c.name);
  const opaValues = opaCols.map((c) => (c.name === 'order_item_id' ? order.id : c.name === 'pipeline_run_id' ? 'run-ord-1' : (/_at$/.test(c.name) ? now : (/INT|REAL|NUM/i.test(c.type) ? 1 : 'x'))));
  for (const need of ['order_item_id', 'pipeline_run_id']) {
    if (!opaNames.includes(need)) { opaNames.push(need); opaValues.push(need === 'order_item_id' ? order.id : 'run-ord-1'); }
  }
  await ctx.backend.run(
    `INSERT INTO order_pipeline_assignments (${opaNames.join(', ')}) VALUES (${opaNames.map(() => '?').join(', ')})`,
    opaValues,
  );
  // The run consumed 6 of the 20.
  await ctx.backend.applyInventoryMovement({
    barcode: material.barcode, movementType: 'consume', qty: 6, fromLocationId: 'MAIN',
    referenceType: 'pipeline_run', referenceId: 'run-ord-1', actor: 'Test',
  });
  assert.equal((await api(ctx, 'GET', `/api/materials/${material.barcode}`)).body.material.onHand, 14);

  const runs = await api(ctx, 'GET', '/api/orders/RT-DEL-2/pipeline-runs');
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.body.runs.map((r) => r.id), ['run-ord-1']);

  const gone = await api(ctx, 'DELETE', `/api/orders/${order.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.deepEqual(gone.body.recoveredMovements, [
    { barcode: material.barcode, qty: 6, reason: 'Raw Material Recovery' },
  ]);
  assert.equal((await api(ctx, 'GET', `/api/materials/${material.barcode}`)).body.material.onHand, 20, 'the stock is back');
  assert.equal(await ctx.backend.get("SELECT id FROM pipeline_runs WHERE id = 'run-ord-1'"), undefined, 'the run is gone');
  const links = await ctx.backend.get('SELECT COUNT(*) AS c FROM order_pipeline_assignments WHERE order_item_id = ?', [order.id]);
  assert.equal(links.c, 0);
});

test('orders: returns start empty, and the trace of an order answers', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  await makeOrder(ctx, 'RT-TRACE-1');

  const returns = await api(ctx, 'GET', '/api/orders/RT-TRACE-1/returns');
  assert.equal(returns.status, 200);
  assert.deepEqual(returns.body.returns, []);

  const runs = await api(ctx, 'GET', '/api/orders/RT-TRACE-1/pipeline-runs');
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.body.runs, []);

  const trace = await api(ctx, 'GET', '/api/orders/RT-TRACE-1/trace');
  assert.equal(trace.status, 200, JSON.stringify(trace.body).slice(0, 300));
  assert.equal(trace.body.success, true);

  const ghostTrace = await api(ctx, 'GET', '/api/orders/NO-SUCH-ORDER/trace');
  assert.ok([200, 404].includes(ghostTrace.status));
  const report = await api(ctx, 'GET', '/api/orders/RT-TRACE-1/production-report');
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 300));
});
