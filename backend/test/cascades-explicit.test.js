const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// B36. A hard delete whose foreign keys cascade into another module's table
// asks that module to remove its rows first, inside the same transaction, so
// the cascade has nothing left to do. These run with the foreign keys OFF on
// the main connection, so a test passes only if the ask did the work.

async function boot() {
  const tempDir = makeTempDir('paper-cascades-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'cascade@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'cascade@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) =>
    fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  // The cascade may not help: anything left is the ask's failure.
  await backend.run('PRAGMA foreign_keys = OFF');
  return { backend, desk: backend.desk, server, api };
}

const count = async (backend, sql, params) => (await backend.get(sql, params)).n;

test('removing a run removes the jobs it raised, and their tasks', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { backend, api } = ctx;
  const template = await backend.get('SELECT id FROM pipeline_templates ORDER BY id LIMIT 1');
  const item = await backend.get('SELECT id FROM items ORDER BY id LIMIT 1');
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Cascade Run' })).body.run;
  const now = new Date().toISOString();
  const job = await backend.run(
    "INSERT INTO freelancer_jobs (run_id, node_id, item_id, quantity, status, created_at, updated_at) VALUES (?, 'n1', ?, 2, 'pending', ?, ?)",
    [run.id, item.id, now, now],
  );
  await backend.run('INSERT INTO freelancer_job_tasks (job_id, item_id, required_quantity, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    [job.lastID, item.id, now, now]).catch(() => {});

  const before = ctx.desk.stats().jobs['jobs.runs.forget'] || 0;
  assert.equal((await api('DELETE', `/runs/${run.id}`)).status, 200);
  assert.equal(ctx.desk.stats().jobs['jobs.runs.forget'], before + 1);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM freelancer_jobs WHERE run_id = ?', [run.id]), 0);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM freelancer_job_tasks WHERE job_id = ?', [job.lastID]), 0);
});

test('removing a die or a machine takes it off every part that lists it', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { backend, api } = ctx;
  const item = await backend.get('SELECT id FROM items ORDER BY id LIMIT 1');
  const madeDie = await api('POST', '/api/dies', { toolCode: 'CASCADE-DIE', status: 'active', ownership: 'inHouse' });
  const madeMachine = await api('POST', '/api/machines', { name: 'Cascade Press', assetId: 'CP-1', status: 'active' });
  assert.ok(madeDie.status < 300, JSON.stringify(madeDie));
  assert.ok(madeMachine.status < 300, JSON.stringify(madeMachine));
  const die = madeDie.body.die;
  const machine = madeMachine.body.machine;
  const now = new Date().toISOString();
  await backend.run('INSERT INTO item_dies (item_id, die_id, created_at) VALUES (?, ?, ?)', [item.id, die.id, now]);
  await backend.run('INSERT INTO item_machines (item_id, machine_id, created_at) VALUES (?, ?, ?)', [item.id, machine.id, now]);

  assert.equal((await api('DELETE', `/api/dies/${die.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/machines/${machine.id}`)).status, 200);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM item_dies WHERE die_id = ?', [die.id]), 0);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM item_machines WHERE machine_id = ?', [machine.id]), 0);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM item_dies WHERE item_id = ?', [item.id]), 0, 'the part itself is untouched apart from that');
  assert.ok(await backend.get('SELECT id FROM items WHERE id = ?', [item.id]));
});

test('removing an order line takes it off the challans that listed it', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { backend } = ctx;
  const client = await backend.get('SELECT id FROM clients WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  // An item with no variations, so the line needs none.
  const item = await backend.saveItem({ name: 'Cascade part', alias: '', displayName: 'Cascade part', groupId: group.id, unitId: unit.id, variationTree: [] });
  const order = await ctx.api('POST', '/api/orders', {
    orderNo: 'CASCADE-1', clientId: client.id, itemId: item.id, variationLeafNodeId: 0,
    variationPathNodeIds: [], quantity: 2, status: 'notStarted',
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const line = order.body.order;
  const challan = await ctx.api('POST', '/api/challans', {
    type: 'delivery', challanNo: 'CASCADE-CH-1', date: '2026-11-19', status: 'draft',
    customerName: 'Walk-in Customer', maintainStocks: false,
    items: [{ itemId: item.id, variationLeafNodeId: 0, particulars: 'x', quantityPcs: '1', weight: '1', lineNo: 1 }],
  });
  assert.equal(challan.status, 201, JSON.stringify(challan.body));
  await backend.run('INSERT OR IGNORE INTO delivery_challan_order_items (challan_id, order_id, created_at) VALUES (?, ?, ?)',
    [challan.body.data.id, line.id, new Date().toISOString()]);
  const gone = await ctx.desk.call('orders.delete', { id: line.id }, { actor: { kind: 'system' } });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM delivery_challan_order_items WHERE order_id = ?', [line.id]), 0);
  assert.equal(await count(backend, 'SELECT COUNT(*) AS n FROM order_pipeline_assignments WHERE order_item_id = ?', [line.id]), 0);
});
