const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDesk } = require('../kernel/desk');
const { jobsClient } = require('../modules/jobs/client');

// Jobs and the action centre behind the kernel desk: the last two modules.
//
// jobs-api and action-center-api pin every HTTP answer, and passed unchanged.
// This file pins what is new: who may ask (neither module's main routes were
// ever behind a module permission), an approved delete request being carried
// out by the module that owns the record, a job's tasks coming from the items
// module's bill of materials, and a CSV download surviving the trip.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-jobs-ac-ops-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'last-two@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'last-two@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const raw = (method, route, body) =>
    fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = (method, route, body) =>
    raw(method, route, body).then(async (r) => ({ status: r.status, body: await r.json() }));
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await backend.saveItem({
    name: 'Jobbed part', alias: '', displayName: 'Jobbed part', groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return { backend, desk: backend.desk, server, api, raw, itemId: item.id };
}

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const as = (role, permissions = {}) => ({
  actor: { kind: 'user', user: { id: 95, role, name: 'Tester' }, permissions },
});

test('a rule and a key may both be asked, and then both must hold', async () => {
  const desk = createDesk();
  desk.register('review', {
    operations: {
      'review.approve': {
        access: { anyRole: ['admin'], anyPermission: ['config.write'] },
        permission: 'delete_requests.review',
        run: async () => ({ ok: true }),
      },
    },
  });
  const code = async (who) => (await desk.call('review.approve', {}, who)).code;
  assert.equal(await code(as('user', { 'delete_requests.review': true })), 'forbidden', 'the key alone is not enough');
  assert.equal(await code(as('user', { 'config.write': true })), 'forbidden', 'the gate alone is not enough');
  assert.equal(await code(as('admin')), 'forbidden', 'an admin still needs the key');
  assert.equal((await desk.call('review.approve', {}, as('user', { 'config.write': true, 'delete_requests.review': true }))).ok, true);
  assert.equal((await desk.call('review.approve', {}, as('admin', { 'delete_requests.review': true }))).ok, true);
});

test('jobs: the same through the desk and over HTTP, with tasks from the bill of materials', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  // A bill of materials line whose material stands for an item.
  const material = (await ctx.api('POST', '/api/materials/parent', {
    name: 'Job Sheet', type: 'Sheet', numberOfChildren: 1, unit: 'Kg',
  })).body.material;
  await ctx.backend.run('UPDATE materials SET linked_item_id = ? WHERE barcode = ?', [ctx.itemId, material.barcode]);
  const now = new Date().toISOString();
  await ctx.backend.run(
    `INSERT INTO item_bom_lines (item_id, material_barcode, quantity_per_unit, wastage_percent, created_at, updated_at)
     VALUES (?, ?, 2, 0, ?, ?)`,
    [ctx.itemId, material.barcode, now, now],
  );

  // The items port used to answer an empty list whatever the item.
  const lines = (await ctx.desk.as('jobs').ask('items.bom.lines', { itemId: ctx.itemId })).value;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].material_barcode, material.barcode);
  const link = (await ctx.desk.as('jobs').ask('inventory.materials.linkOf', { barcode: material.barcode })).link;
  assert.equal(link.linked_item_id, ctx.itemId);
  assert.equal((await ctx.desk.as('jobs').ask('inventory.materials.linkOf', { barcode: 'NO-SUCH' })).link, null);

  const created = await ctx.api('POST', '/api/freelancer-jobs', { item_id: ctx.itemId, quantity: 3 });
  assert.ok(created.status < 300, JSON.stringify(created.body));

  const viaHttp = await ctx.api('GET', '/api/freelancer-jobs');
  const viaDesk = await ctx.desk.call('jobs.list', { query: {} }, system);
  assert.equal(viaHttp.status, 200);
  const { ok, ...rest } = viaDesk;
  assert.deepEqual(viaHttp.body, { success: true, ...plain(rest) });
  // The job got a task for the material's item: 2 per unit × 3.
  assert.ok(JSON.stringify(viaHttp.body).includes('"required_quantity":6') || JSON.stringify(viaHttp.body).includes('"requiredQuantity":6'),
    JSON.stringify(viaHttp.body).slice(0, 600));

  // Who may ask: nothing here was ever behind a jobs permission.
  assert.equal((await ctx.desk.call('jobs.list', { query: {} }, as('user'))).ok, true);
  assert.equal((await ctx.desk.call('jobs.create', { data: {} }, as('user', { 'jobs.create': true }))).code, 'forbidden');
  assert.notEqual((await ctx.desk.call('jobs.create', { data: {} }, as('user', { 'inventory.update': true }))).code, 'forbidden');

  // Production holds a jobs client and nothing else may use it.
  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  assert.deepEqual(listed['jobs.syncAssemblyJob'].usedBy, ['production']);
  await assert.rejects(
    jobsClient(ctx.desk.as('orders')).syncAssemblyJob({ runId: 'r', nodeId: 'n', itemId: ctx.itemId, qty: 1 }),
    (error) => error.code === 'not_declared',
  );
});

test('the action centre: an approved delete request is carried out by the module that owns the record', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const vendor = (await ctx.api('POST', '/api/vendors', { name: 'Doomed Vendor' })).body.vendor;
  const made = await ctx.api('POST', '/api/delete-requests', {
    entityType: 'vendor', entityId: vendor.id, entityLabel: 'Doomed Vendor', reason: 'test',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  // Lists agree.
  const listHttp = await ctx.api('GET', '/api/delete-requests?status=pending');
  const listDesk = await ctx.desk.call('action_center.deleteRequests.list', { query: { status: 'pending' } }, system);
  const { ok, ...rest } = listDesk;
  assert.deepEqual(listHttp.body, { success: true, ...plain(rest) });

  // Who may ask.
  const approve = { id: made.body.request.id, data: { note: 'ok' } };
  const code = async (who) => (await ctx.desk.call('action_center.deleteRequests.approve', approve, who)).code;
  assert.equal(await code(as('user', { 'delete_requests.review': true })), 'forbidden');
  assert.equal(await code(as('user', { 'config.write': true })), 'forbidden');
  assert.equal((await ctx.desk.call('action_center.deleteRequests.create', { data: {} }, as('user'))).code === 'forbidden', false);
  assert.equal((await ctx.desk.call('action_center.trash.list', { query: {} }, as('user'))).code, 'forbidden');
  assert.equal((await ctx.desk.call('action_center.trash.list', { query: {} }, as('user', { 'action_center.read': true }))).ok, true);

  // Approving it asks vendors to remove the row, and counts the call.
  const before = ctx.desk.stats().vendors['vendors.rows.remove'];
  const approved = await ctx.api('POST', `/api/delete-requests/${made.body.request.id}/approve`, { note: 'ok' });
  assert.ok(approved.status < 300, JSON.stringify(approved.body));
  assert.equal(ctx.desk.stats().vendors['vendors.rows.remove'], before + 1);
  assert.equal((await ctx.api('GET', `/api/vendors/${vendor.id}`)).status, 404);

  // Nobody but the action centre may ask for a row to be removed like that.
  assert.equal((await ctx.desk.as('orders').call('vendors.rows.remove', { id: 1 })).code, 'not_declared');
  assert.equal((await ctx.desk.as('action_center').call('orders.delete', { id: 1 })).code, 'not_declared');

  // The CSV export is still a file.
  const csv = await ctx.raw('GET', '/api/delete-requests/export');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /delete_requests_export\.csv/);
  const csvDesk = await ctx.desk.call('action_center.deleteRequests.export', { query: {} }, system);
  assert.equal(csvDesk.file.contentType, 'text/csv');
  assert.equal(await csv.text(), String(csvDesk.file.buffer));

  // The integrity scan answers, through both doors alike.
  const issuesHttp = await ctx.api('GET', '/api/action-center/issues');
  const issuesDesk = await ctx.desk.call('action_center.issues', { query: {} }, system);
  assert.equal(issuesHttp.status, 200);
  const { ok: _ok, ...issues } = issuesDesk;
  assert.deepEqual(issuesHttp.body, { success: true, ...plain(issues) });

  const broken = Object.entries(ctx.desk.violationCounts())
    .filter(([name]) => name.startsWith('jobs.') || name.startsWith('action_center.'));
  assert.deepEqual(broken, []);
});
