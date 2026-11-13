const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The client master over HTTP, the parts client-archive.test.js and
// party-contacts.test.js do not reach: the plain save and its refusals, the rule
// that a client on a live order keeps its name and GST, its sub-contractors, and
// the B2B portal that hangs off a client (credentials, catalogue, login, cart,
// placing an order).
//
// Written before the clients code left server.js.

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-clients-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'clients@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'clients@example.test', password: 'OwnerPass1234' }),
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

async function firstItemId(ctx) {
  const row = await ctx.backend.get('SELECT id FROM items ORDER BY id LIMIT 1');
  assert.ok(row, 'demo seed must provide an item');
  return row.id;
}

/// An item with no variations, which is the only kind an order line can name
/// without also naming a variation leaf.
async function simpleItemId(ctx, name) {
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  assert.ok(group && unit, 'demo seed must provide a group and a unit');
  const item = await ctx.backend.saveItem({
    name,
    alias: '',
    displayName: name,
    groupId: group.id,
    unitId: unit.id,
    variationTree: [],
  });
  return item.id;
}

test('clients: create, read, list, update, and what a save refuses', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const created = await api(ctx, 'POST', '/api/clients', {
    name: 'Kappa Works',
    alias: 'KW',
    gstNumber: '27 aaaaa0000a1z5',
    address: 'Pune',
    contactName: 'Asha',
    phone: '9000000009',
  });
  assert.equal(created.status, 201);
  const client = created.body.client;
  assert.equal(client.gstNumber, '27AAAAA0000A1Z5');
  assert.equal(client.usageCount, 0);
  assert.equal(client.contactName, 'Asha');
  assert.ok(Array.isArray(client.contacts));

  const one = await api(ctx, 'GET', `/api/clients/${client.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.client.name, 'Kappa Works');
  assert.equal((await api(ctx, 'GET', '/api/clients/999999')).status, 404);

  const list = await api(ctx, 'GET', '/api/clients');
  assert.ok(list.body.clients.some((c) => c.id === client.id));
  const live = list.body.clients.filter((c) => !c.isArchived).map((c) => c.name.toLowerCase());
  assert.deepEqual(live, [...live].sort(), 'live clients read in name order');

  const patched = await api(ctx, 'PATCH', `/api/clients/${client.id}`, { address: 'Mumbai' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.client.address, 'Mumbai');
  assert.equal(patched.body.client.alias, 'KW', 'what the patch did not mention is kept');
  assert.equal(patched.body.client.gstNumber, '27AAAAA0000A1Z5');

  assert.equal((await api(ctx, 'POST', '/api/clients', { name: '  ' })).status, 400);
  const shortGst = await api(ctx, 'POST', '/api/clients', { name: 'Lambda', gstNumber: '123' });
  assert.equal(shortGst.status, 400);
  assert.match(shortGst.body.error, /15 characters/);

  const sameName = await api(ctx, 'POST', '/api/clients', { name: 'kappa   works' });
  assert.equal(sameName.status, 409);
  assert.match(sameName.body.error, /same name/);
  const sameGst = await api(ctx, 'POST', '/api/clients', { name: 'Mu', gstNumber: '27AAAAA0000A1Z5' });
  assert.equal(sameGst.status, 409);
  assert.match(sameGst.body.error, /GST number/);

  assert.equal((await api(ctx, 'PATCH', '/api/clients/999999', { name: 'Nobody' })).status, 404);
});

test('clients: one on a live order keeps its name and GST, and counts as used', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await simpleItemId(ctx, 'Lock Test Item');

  const client = (await api(ctx, 'POST', '/api/clients', {
    name: 'Nu Industries',
    gstNumber: '29AAAAA0000A1Z5',
  })).body.client;
  const now = new Date().toISOString();
  await ctx.backend.run(
    `INSERT INTO order_headers (order_no, client_id, created_at, updated_at) VALUES ('LOCK-1', ?, ?, ?)`,
    [client.id, now, now],
  );
  await ctx.backend.saveOrder({
    orderNo: 'LOCK-1',
    clientId: client.id,
    itemId,
    variationLeafNodeId: 0,
    variationPathNodeIds: [],
    quantity: 3,
    status: 'inProgress',
  }, { returnMeta: false });

  const one = await api(ctx, 'GET', `/api/clients/${client.id}`);
  assert.equal(one.body.client.usageCount, 1);
  const list = await api(ctx, 'GET', '/api/clients');
  assert.equal(list.body.clients.find((c) => c.id === client.id).usageCount, 1);

  const rename = await api(ctx, 'PATCH', `/api/clients/${client.id}`, { name: 'Nu Industries Ltd' });
  assert.equal(rename.status, 409);
  assert.match(rename.body.error, /Used clients cannot change name or GST number/);

  const address = await api(ctx, 'PATCH', `/api/clients/${client.id}`, { address: 'Delhi' });
  assert.equal(address.status, 200, 'a non-identity field is still editable');
});

test('clients: sub-contractors are created, listed, kept on a partial update, and removed', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Xi Corp' })).body.client;

  const blank = await api(ctx, 'POST', `/api/clients/${client.id}/sub-contractors`, { name: ' ' });
  assert.equal(blank.status, 400);

  const made = await api(ctx, 'POST', `/api/clients/${client.id}/sub-contractors`, {
    name: 'Omicron Jobwork',
    phone: '9000000010',
    gstNumber: '27AAAAA0000A1Z5',
    address: 'Thane',
  });
  assert.equal(made.status, 201);
  const sub = made.body.subContractor;
  assert.equal(sub.clientId, client.id);

  const mine = await api(ctx, 'GET', `/api/clients/${client.id}/sub-contractors`);
  assert.deepEqual(mine.body.subContractors.map((s) => s.id), [sub.id]);
  const all = await api(ctx, 'GET', '/api/sub-contractors');
  const row = all.body.subContractors.find((s) => s.id === sub.id);
  assert.equal(row.clientName, 'Xi Corp', 'the all-clients list names the client');

  const updated = await api(ctx, 'PUT', `/api/sub-contractors/${sub.id}`, {
    name: 'Omicron Jobwork',
    phone: '9000000011',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.subContractor.phone, '9000000011');
  assert.equal(updated.body.subContractor.gstNumber, '27AAAAA0000A1Z5', 'unmentioned fields are kept');
  assert.equal(updated.body.subContractor.address, 'Thane');

  assert.equal((await api(ctx, 'PUT', '/api/sub-contractors/999999', { name: 'Nobody' })).status, 404);

  assert.equal((await api(ctx, 'DELETE', `/api/sub-contractors/${sub.id}`)).status, 200);
  const after = await api(ctx, 'GET', `/api/clients/${client.id}/sub-contractors`);
  assert.deepEqual(after.body.subContractors, []);
});

test('clients: the portal login, catalogue, cart and order', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await simpleItemId(ctx, 'Portal Test Item');

  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Pi Buyers' })).body.client;

  const noCreds = await api(ctx, 'POST', `/api/clients/${client.id}/portal-credentials`, { email: 'a@b.c' });
  assert.equal(noCreds.status, 400);
  const creds = await api(ctx, 'POST', `/api/clients/${client.id}/portal-credentials`, {
    email: 'buyer@pi.test',
    password: 'pw-1',
  });
  assert.equal(creds.status, 200);
  const again = await api(ctx, 'POST', `/api/clients/${client.id}/portal-credentials`, {
    email: 'buyer@pi.test',
    password: 'pw-2',
  });
  assert.equal(again.status, 200, 'credentials upsert');

  const wrong = await api(ctx, 'POST', '/api/portal/login', { email: 'buyer@pi.test', password: 'pw-1' });
  assert.equal(wrong.status, 401);
  const login = await api(ctx, 'POST', '/api/portal/login', { email: 'buyer@pi.test', password: 'pw-2' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.client_id, client.id);
  const portalUserId = login.body.user.id;

  const set = await api(ctx, 'POST', `/api/clients/${client.id}/portal-catalog`, { itemIds: [itemId] });
  assert.equal(set.status, 200);
  const got = await api(ctx, 'GET', `/api/clients/${client.id}/portal-catalog`);
  assert.deepEqual(got.body.itemIds, [itemId]);

  assert.equal((await api(ctx, 'GET', '/api/portal/catalog')).status, 400);
  const catalog = await api(ctx, 'GET', `/api/portal/catalog?client_id=${client.id}`);
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.items.some((i) => i.id === itemId));

  assert.equal((await api(ctx, 'POST', '/api/portal/cart', { portal_user_id: portalUserId })).status, 400);
  await api(ctx, 'POST', '/api/portal/cart', { portal_user_id: portalUserId, item_id: itemId, quantity: 2 });
  await api(ctx, 'POST', '/api/portal/cart', { portal_user_id: portalUserId, item_id: itemId, quantity: 3 });
  const cart = await ctx.backend.get(
    'SELECT quantity FROM portal_carts WHERE portal_user_id = ? AND item_id = ?',
    [portalUserId, itemId],
  );
  assert.equal(cart.quantity, 5, 'adding the same item again adds to the cart');

  assert.equal((await api(ctx, 'POST', '/api/portal/orders', { portal_user_id: portalUserId, items: [] })).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/portal/orders', { portal_user_id: 999999, items: [{ item_id: itemId, quantity: 1 }] })).status, 404);

  // The route owns one transaction (header, every line, cart clear) and tells
  // saveOrder not to open its own. It used to open one too, SQLite refused the
  // nested BEGIN, and a portal order never went through.
  const order = await api(ctx, 'POST', '/api/portal/orders', {
    portal_user_id: portalUserId,
    items: [{ item_id: itemId, quantity: 4 }],
  });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  assert.match(order.body.orderNo, /^B2B-ORD-/);
  const header = await ctx.backend.get('SELECT client_id FROM order_headers WHERE order_no = ?', [order.body.orderNo]);
  assert.equal(header.client_id, client.id);
  const line = await ctx.backend.get('SELECT quantity, status FROM order_items WHERE order_no = ?', [order.body.orderNo]);
  assert.equal(line.quantity, 4);
  assert.equal(line.status, 'draft');
  const left = await ctx.backend.get('SELECT COUNT(*) AS c FROM portal_carts WHERE portal_user_id = ?', [portalUserId]);
  assert.equal(left.c, 0, 'placing an order empties the cart');
});

test('clients: a portal order that fails leaves no header, no line, and the cart as it was', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const goodItem = await simpleItemId(ctx, 'Portal Good Item');

  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Rho Buyers' })).body.client;
  await api(ctx, 'POST', `/api/clients/${client.id}/portal-credentials`, { email: 'rho@pi.test', password: 'pw' });
  const portalUserId = (await api(ctx, 'POST', '/api/portal/login', { email: 'rho@pi.test', password: 'pw' })).body.user.id;
  await api(ctx, 'POST', '/api/portal/cart', { portal_user_id: portalUserId, item_id: goodItem, quantity: 2 });

  // The first line is fine; the second names an item that is not there. The
  // whole order has to go, including the line that would have been saved.
  const failed = await api(ctx, 'POST', '/api/portal/orders', {
    portal_user_id: portalUserId,
    items: [{ item_id: goodItem, quantity: 1 }, { item_id: 999999, quantity: 1 }],
  });
  assert.equal(failed.status, 500);
  const headers = await ctx.backend.get("SELECT COUNT(*) AS c FROM order_headers WHERE order_no LIKE 'B2B-ORD-%'");
  assert.equal(headers.c, 0, 'no header survives');
  const lines = await ctx.backend.get("SELECT COUNT(*) AS c FROM order_items WHERE order_no LIKE 'B2B-ORD-%'");
  assert.equal(lines.c, 0, 'and neither does the line that saved before the failure');
  const cart = await ctx.backend.get('SELECT quantity FROM portal_carts WHERE portal_user_id = ?', [portalUserId]);
  assert.equal(cart.quantity, 2, 'the cart is untouched');
});
