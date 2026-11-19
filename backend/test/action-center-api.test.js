const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The action center: delete requests (create, list, approve, reject, export),
// the trash (what a delete leaves behind, and bringing it back), and the
// integrity scan.
//
// Only approving a MATERIAL request was pinned before (auth-api). This pins the
// rest, as it behaves today, before the code leaves server.js, including the
// oddities: an approved vendor, machine, die or user request does a raw delete
// that skips the in-use checks and the trash, and a request with a type the
// switch does not know is marked approved while deleting nothing.

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
  const tempDir = makeTempDir('paper-actioncenter-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'actioncenter@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'actioncenter@example.test', password: 'OwnerPass1234' }),
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

async function staffToken(ctx) {
  const made = await api(ctx, 'POST', '/api/users', {
    name: 'Floor User',
    email: 'floor@example.test',
    password: 'WorkerPass1234',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const login = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'floor@example.test', password: 'WorkerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token);
  return login.token;
}

async function request(ctx, entityType, entityId, label = 'thing') {
  const res = await api(ctx, 'POST', '/api/delete-requests', {
    entityType,
    entityId,
    entityLabel: label,
    reason: 'test',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.request;
}

async function simpleItem(ctx, name) {
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name, alias: '', displayName: name, groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return item.id;
}

async function trashRows(ctx, table) {
  return ctx.backend.all('SELECT * FROM deleted_records WHERE table_name = ?', [table]);
}

test('delete requests: create, list with a filter, and the guards', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  assert.equal((await api(ctx, 'POST', '/api/delete-requests', { entityType: 'item' })).status, 400);
  const first = await request(ctx, 'item', '1', 'Widget');
  assert.equal(first.status, 'pending');
  assert.equal(first.entityLabel, 'Widget');
  assert.ok(first.requestedByUserId);

  const pending = await api(ctx, 'GET', '/api/delete-requests?status=pending');
  assert.equal(pending.status, 200);
  assert.equal(pending.body.total, 1);
  assert.equal(pending.body.requests[0].id, first.id);
  const approved = await api(ctx, 'GET', '/api/delete-requests?status=approved');
  assert.equal(approved.body.total, 0);
  const junkFilter = await api(ctx, 'GET', '/api/delete-requests?status=nonsense');
  assert.equal(junkFilter.body.total, 1, 'a status it does not know is ignored, not an error');

  // Anyone signed in may ASK; only a reviewer may list or decide.
  const staff = await staffToken(ctx);
  const staffHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${staff}` };
  const asked = await fetch(`${ctx.baseUrl}/api/delete-requests`, {
    method: 'POST',
    headers: staffHeaders,
    body: JSON.stringify({ entityType: 'item', entityId: '2' }),
  });
  assert.equal(asked.status, 201);
  const listed = await fetch(`${ctx.baseUrl}/api/delete-requests`, { headers: staffHeaders });
  assert.equal(listed.status, 403);
  const exported = await fetch(`${ctx.baseUrl}/api/delete-requests/export`, { headers: staffHeaders });
  assert.equal(exported.status, 403);
  const decided = await fetch(`${ctx.baseUrl}/api/delete-requests/${first.id}/approve`, {
    method: 'POST',
    headers: staffHeaders,
    body: '{}',
  });
  assert.equal(decided.status, 403);
});

test('delete requests: reject and export, and a request can be decided once', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const one = await request(ctx, 'item', '1', 'Keep me');
  const two = await request(ctx, 'item', '2', 'Other');

  const rejected = await api(ctx, 'POST', `/api/delete-requests/${one.id}/reject`, { note: 'still needed' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.request.status, 'rejected');
  assert.equal(rejected.body.request.reviewedNote, 'still needed');
  assert.ok(rejected.body.request.reviewedAt);

  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${one.id}/reject`, {})).status, 400);
  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${one.id}/approve`, {})).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/delete-requests/999999/approve', {})).status, 404);
  assert.equal((await api(ctx, 'POST', '/api/delete-requests/999999/reject', {})).status, 404);

  const csv = await fetch(`${ctx.baseUrl}/api/delete-requests/export`, { headers: ctx.headers });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.ok(text.startsWith('id,entityType,entityId,entityLabel,status,createdAt,reviewedAt\n'));
  assert.ok(text.includes('Keep me') && text.includes('Other'));
  assert.ok(two.id);
});

test('approving: an item goes to the trash and can be brought back', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await simpleItem(ctx, 'Doomed Item');

  const req = await request(ctx, 'item', String(itemId), 'Doomed Item');
  const done = await api(ctx, 'POST', `/api/delete-requests/${req.id}/approve`, { note: 'ok' });
  assert.equal(done.status, 200);
  assert.equal(done.body.request.status, 'approved');
  assert.equal(done.body.request.reviewedNote, 'ok');
  assert.equal(await ctx.backend.get('SELECT id FROM items WHERE id = ?', [itemId]), undefined);

  const trash = await api(ctx, 'GET', '/api/trash?tableName=items');
  assert.equal(trash.status, 200);
  const entry = trash.body.records.find((r) => r.recordId === itemId);
  assert.ok(entry, 'the item is in the trash');
  assert.equal(entry.label, 'Doomed Item');
  assert.ok(entry.deletedBy);
  assert.equal(entry.tableName, 'items');

  const restored = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'items', recordId: itemId });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.restored, { tableName: 'items', recordId: itemId });
  assert.ok(await ctx.backend.get('SELECT id FROM items WHERE id = ?', [itemId]));
  assert.equal((await trashRows(ctx, 'items')).filter((r) => r.record_id === itemId).length, 0);

  const again = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'items', recordId: itemId });
  assert.equal(again.status, 404, 'nothing left in the trash for it');
});

test('approving: a group, an inventory set and a material', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const group = (await api(ctx, 'POST', '/api/groups', { name: 'Doomed Group', groupType: 'machine', groupStructure: 'hierarchical' })).body.group;
  const g = await request(ctx, 'group', String(group.id));
  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${g.id}/approve`, {})).status, 200);
  assert.equal(await ctx.backend.get('SELECT id FROM groups WHERE id = ?', [group.id]), undefined);
  assert.equal((await trashRows(ctx, 'groups')).filter((r) => r.record_id === group.id).length, 1);

  const itemId = await simpleItem(ctx, 'Set Member');
  const set = (await api(ctx, 'POST', '/api/inventory/sets', {
    name: 'Doomed Set',
    lines: [{ itemId, variationLeafNodeId: 0, quantity: 2 }],
  })).body.set;
  const s = await request(ctx, 'inventory_set', String(set.id));
  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${s.id}/approve`, {})).status, 200);
  assert.equal(await ctx.backend.get('SELECT id FROM inventory_sets WHERE id = ?', [set.id]), undefined);

  const material = (await api(ctx, 'POST', '/api/materials/parent', { name: 'Doomed Sheet', type: 'Sheet', numberOfChildren: 1, unit: 'Kg' })).body.material;
  const m = await request(ctx, 'material', material.barcode);
  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${m.id}/approve`, {})).status, 200);
  assert.equal((await api(ctx, 'GET', `/api/materials/${material.barcode}`)).status, 404);
});

test('approving: a vendor, a machine and a die are removed outright, with no trash entry', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const vendor = (await api(ctx, 'POST', '/api/vendors', { name: 'Doomed Vendor' })).body.vendor;
  const machine = (await api(ctx, 'POST', '/api/machines', { name: 'Doomed Machine', assetId: 'DM-1', status: 'active' })).body.machine;
  const die = (await api(ctx, 'POST', '/api/dies', { toolCode: 'DD-1', status: 'active', ownership: 'inHouse' })).body.die;

  for (const [type, id, table] of [['vendor', vendor.id, 'vendors'], ['machine', machine.id, 'machines'], ['die', die.id, 'dies']]) {
    const r = await request(ctx, type, String(id));
    const done = await api(ctx, 'POST', `/api/delete-requests/${r.id}/approve`, {});
    assert.equal(done.status, 200, `${type}: ${JSON.stringify(done.body)}`);
    assert.equal(await ctx.backend.get(`SELECT id FROM ${table} WHERE id = ?`, [id]), undefined, `${type} is gone`);
    assert.equal((await trashRows(ctx, table)).length, 0, `${type} left nothing in the trash: it cannot be restored`);
  }
});

test('approving: a vendor that challans still name is refused by the database as a 500, and the request stays pending', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const vendor = (await api(ctx, 'POST', '/api/vendors', { name: 'Busy Vendor' })).body.vendor;
  const now = new Date().toISOString();
  await ctx.backend.run(
    `INSERT INTO delivery_challans (type, challan_no, date, vendor_id, vendor_name, status, created_at, updated_at)
     VALUES ('reception', 'GAP-1', ?, ?, 'x', 'issued', ?, ?)`,
    [now.slice(0, 10), vendor.id, now, now],
  );
  // The DELETE route checks and answers 409 vendor_in_use. The request path does
  // no check of its own: it runs a raw DELETE, and only the foreign key stops it,
  // so the admin sees a bare 500 instead of the sentence. Nothing is lost.
  const direct = await api(ctx, 'DELETE', `/api/vendors/${vendor.id}`);
  assert.equal(direct.status, 409);
  const r = await request(ctx, 'vendor', String(vendor.id));
  const done = await api(ctx, 'POST', `/api/delete-requests/${r.id}/approve`, {});
  assert.equal(done.status, 500);
  assert.match(done.body.error, /FOREIGN KEY/i);
  assert.ok(await ctx.backend.get('SELECT id FROM vendors WHERE id = ?', [vendor.id]), 'the vendor is still there');
  const still = await api(ctx, 'GET', '/api/delete-requests?status=pending');
  assert.equal(still.body.total, 1, 'and the request is still pending');
});

test('approving: a type the switch does not know is refused, and the request stays pending', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await simpleItem(ctx, 'Untouched Item');
  const r = await request(ctx, 'spaceship', String(itemId));
  // It used to answer 200, mark the request approved and delete nothing, which
  // read as a successful deletion that had not happened.
  const done = await api(ctx, 'POST', `/api/delete-requests/${r.id}/approve`, {});
  assert.equal(done.status, 400);
  assert.match(done.body.error, /"spaceship" is not a kind of record/);
  assert.ok(await ctx.backend.get('SELECT id FROM items WHERE id = ?', [itemId]), 'nothing was deleted');
  const still = await api(ctx, 'GET', '/api/delete-requests?status=pending');
  assert.equal(still.body.total, 1, 'and it is still waiting for a decision');
  const prototypeName = await request(ctx, 'constructor', '1');
  assert.equal((await api(ctx, 'POST', `/api/delete-requests/${prototypeName.id}/approve`, {})).status, 400, 'a name from Object itself is not a kind either');
});

test('trash: restore refuses what it should, and a live row is never clobbered', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  assert.equal((await api(ctx, 'POST', '/api/trash/restore', {})).status, 400);
  const notRestorable = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'machines', recordId: 1 });
  assert.equal(notRestorable.status, 400);
  assert.match(notRestorable.body.error, /not restorable/);
  assert.equal((await api(ctx, 'POST', '/api/trash/restore', { tableName: 'clients', recordId: 999999 })).status, 404);

  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Trash Client' })).body.client;
  assert.equal((await api(ctx, 'DELETE', `/api/clients/${client.id}`)).status, 200);
  assert.equal((await trashRows(ctx, 'clients')).filter((r) => r.record_id === client.id).length, 1);

  // Put a different live row on the same id, then try to restore over it.
  const now = new Date().toISOString();
  await ctx.backend.run(
    'INSERT INTO clients (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [client.id, 'Squatter', now, now],
  );
  const clash = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'clients', recordId: client.id });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /already exists/);
  await ctx.backend.run('DELETE FROM clients WHERE id = ?', [client.id]);

  const ok = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'clients', recordId: client.id });
  assert.equal(ok.status, 200);
  const back = await api(ctx, 'GET', `/api/clients/${client.id}`);
  assert.equal(back.body.client.name, 'Trash Client');

  await ctx.backend.run('DELETE FROM clients WHERE id = ?', [client.id]);
  await ctx.backend.run(
    "INSERT INTO deleted_records (table_name, record_id, data_json, deleted_at, deleted_by) VALUES ('clients', ?, 'not json', ?, 'x')",
    [client.id, now],
  );
  const corrupt = await api(ctx, 'POST', '/api/trash/restore', { tableName: 'clients', recordId: client.id });
  assert.equal(corrupt.status, 422);
});

test('trash: deleting a department trashes every employee in it', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const dept = (await api(ctx, 'POST', '/api/departments', { name: 'Doomed Dept' })).body.department;
  for (const name of ['A', 'B', 'C']) {
    await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name });
  }
  assert.equal((await api(ctx, 'DELETE', `/api/departments/${dept.id}`)).status, 200);
  assert.equal((await trashRows(ctx, 'employees')).length, 3);
  assert.equal((await trashRows(ctx, 'departments')).length, 1);
  const list = await api(ctx, 'GET', '/api/trash');
  assert.ok(list.body.total >= 4);
  assert.ok(list.body.records.every((r) => r.label));
});

test('issues: a dangling reference is reported with who holds it and what is missing', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const clean = await api(ctx, 'GET', '/api/action-center/issues');
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body.scanErrors, []);
  const before = clean.body.total;

  const itemId = await simpleItem(ctx, 'Orphan Item');
  await ctx.backend.run('PRAGMA foreign_keys = OFF');
  await ctx.backend.run('UPDATE items SET group_id = 987654 WHERE id = ?', [itemId]);

  const found = await api(ctx, 'GET', '/api/action-center/issues');
  assert.equal(found.body.total, before + 1);
  const issue = found.body.issues.find((i) => i.ownerTable === 'items' && i.ownerId === itemId);
  assert.ok(issue);
  assert.equal(issue.type, 'broken_reference');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.brokenTable, 'groups');
  assert.equal(issue.brokenField, 'group_id');
  assert.equal(issue.brokenId, 987654);
  assert.equal(issue.ownerLabel, 'Orphan Item');
  assert.deepEqual(found.body.scanErrors, []);
});
