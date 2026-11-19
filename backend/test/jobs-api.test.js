const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The freelancer job pool over HTTP: the hand-raised half of it. Jobs raised
// by an Assembly node, and batching them out to a worker, are pinned by
// assembly-job-dedupe.test.js; this file covers the plain CRUD and the
// worker's own read, which that file does not.
//
// Written before the jobs code left server.js.

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
  const tempDir = makeTempDir('paper-jobs-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'jobs@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jobs@example.test', password: 'OwnerPass1234' }),
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

// What a card used to carry: the barcode encrypted with a key that was written
// in the source, so anyone with the code could make one. The server no longer
// accepts these; it signs the token itself (GET /api/freelancer-jobs/portal-token).
function oldForgeableToken(barcodeId) {
  const secret = 'my-very-secret-key-32charslong!!';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secret), iv);
  const encrypted = Buffer.concat([cipher.update(barcodeId), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

async function portalToken(ctx, barcodeId) {
  const res = await api(ctx, 'GET', `/api/freelancer-jobs/portal-token?barcodeId=${encodeURIComponent(barcodeId)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token;
}

async function firstItemId(ctx) {
  const row = await ctx.backend.get('SELECT id FROM items ORDER BY id LIMIT 1');
  assert.ok(row, 'demo seed must provide an item');
  return row.id;
}

test('jobs: raise, read, move and remove a hand-made job', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await firstItemId(ctx);

  const created = await api(ctx, 'POST', '/api/freelancer-jobs', { item_id: itemId, quantity: 12 });
  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);
  const job = created.body.job;
  assert.equal(job.item_id, itemId);
  assert.equal(job.quantity, 12);
  assert.equal(job.status, 'pending');
  assert.equal(job.batch_id, null, 'a new job waits in the pool, unassigned');

  const list = await api(ctx, 'GET', '/api/freelancer-jobs');
  assert.equal(list.status, 200);
  assert.ok(list.body.jobs.some((j) => j.id === job.id));
  assert.ok(Array.isArray(list.body.tasks));
  assert.ok(Array.isArray(list.body.batches));

  const moved = await api(ctx, 'PUT', `/api/freelancer-jobs/${job.id}`, { status: 'inProgress' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.job.status, 'inProgress');

  const gone = await api(ctx, 'DELETE', `/api/freelancer-jobs/${job.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.success, true);
  const after = await api(ctx, 'GET', '/api/freelancer-jobs');
  assert.ok(!after.body.jobs.some((j) => j.id === job.id));
});

test('jobs: a job takes one task per BOM line whose material is a known item', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await firstItemId(ctx);
  const now = new Date().toISOString();

  // A material that points at an item, and a BOM line that uses it.
  await ctx.backend.run(
    `INSERT INTO materials (barcode, name, type, kind, linked_item_id, created_at, updated_at)
     VALUES ('MAT-JOBS-1', 'Rivet', 'raw', 'parent', ?, ?, ?)`,
    [itemId, now, now],
  );
  await ctx.backend.run(
    `INSERT INTO item_bom_lines (item_id, material_barcode, quantity_per_unit, wastage_percent, created_at, updated_at)
     VALUES (?, 'MAT-JOBS-1', 2, 10, ?, ?)`,
    [itemId, now, now],
  );

  const created = await api(ctx, 'POST', '/api/freelancer-jobs', { item_id: itemId, quantity: 5 });
  assert.equal(created.status, 200);
  const list = await api(ctx, 'GET', '/api/freelancer-jobs');
  const tasks = list.body.tasks.filter((x) => x.job_id === created.body.job.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].item_id, itemId);
  assert.ok(Math.abs(tasks[0].required_quantity - 11) < 1e-9, '2 per unit x 5, plus 10% wastage');
});

test('jobs: the worker portal refuses a missing or tampered token', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  // Behind the /api auth gate like everything else: the token says WHICH
  // worker, the bearer says someone may ask.
  const unauthenticated = await fetch(`${ctx.baseUrl}/api/freelancer-portal/data`);
  assert.equal(unauthenticated.status, 401);

  const none = await fetch(`${ctx.baseUrl}/api/freelancer-portal/data`, { headers: ctx.headers });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).error, 'Missing token');

  const bad = await fetch(`${ctx.baseUrl}/api/freelancer-portal/data?token=nonsense:zz`, {
    headers: ctx.headers,
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Invalid or tampered token');

  const stranger = await fetch(
    `${ctx.baseUrl}/api/freelancer-portal/data?token=${encodeURIComponent(await portalToken(ctx, 'NOBODY-HAS-THIS'))}`,
    { headers: ctx.headers },
  );
  assert.equal(stranger.status, 404);
  assert.equal((await stranger.json()).error, 'Freelancer not found');
});

test('jobs: the worker portal shows only that worker\'s batches, jobs and tasks', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const itemId = await firstItemId(ctx);
  const now = new Date().toISOString();

  const deptRow = await ctx.backend.run(
    `INSERT INTO departments (name, description, photo_url, created_at, updated_at) VALUES ('Assembly', '', '', ?, ?)`,
    [now, now],
  );
  const dept = { id: deptRow.lastID };
  const mine = await ctx.backend.run(
    `INSERT INTO employees (name, barcode_id, department_id, created_at, updated_at) VALUES ('Worker A', 'EMP-JOBS-A', ?, ?, ?)`,
    [dept.id, now, now],
  );
  const theirs = await ctx.backend.run(
    `INSERT INTO employees (name, barcode_id, department_id, created_at, updated_at) VALUES ('Worker B', 'EMP-JOBS-B', ?, ?, ?)`,
    [dept.id, now, now],
  );

  const jobA = (await api(ctx, 'POST', '/api/freelancer-jobs', { item_id: itemId, quantity: 3 })).body.job;
  const jobB = (await api(ctx, 'POST', '/api/freelancer-jobs', { item_id: itemId, quantity: 4 })).body.job;
  await api(ctx, 'POST', '/api/freelancer-jobs/batches', { freelancer_id: mine.lastID, job_ids: [jobA.id] });
  await api(ctx, 'POST', '/api/freelancer-jobs/batches', { freelancer_id: theirs.lastID, job_ids: [jobB.id] });

  const res = await fetch(
    `${ctx.baseUrl}/api/freelancer-portal/data?token=${encodeURIComponent(await portalToken(ctx, 'EMP-JOBS-A'))}`,
    { headers: ctx.headers },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.batches.length, 1);
  assert.equal(body.batches[0].freelancer_id, mine.lastID);

  // A token made with the key that used to be in the source opens nothing,
  // and neither does this worker's token edited to name the other worker.
  const card = (token) => fetch(
    `${ctx.baseUrl}/api/freelancer-portal/data?token=${encodeURIComponent(token)}`,
    { headers: ctx.headers },
  );
  assert.equal((await card(oldForgeableToken('EMP-JOBS-A'))).status, 400);
  const own = await portalToken(ctx, 'EMP-JOBS-A');
  const [version, , signature] = own.split('.');
  const edited = [version, Buffer.from('EMP-JOBS-B').toString('base64url'), signature].join('.');
  assert.equal((await card(edited)).status, 400);
  // A token names its worker and is stable, so a reprinted card is the same card.
  assert.equal(own, await portalToken(ctx, 'EMP-JOBS-A'));
  assert.equal((await api(ctx, 'GET', '/api/freelancer-jobs/portal-token')).status, 400);
  assert.deepEqual(body.jobs.map((j) => j.id), [jobA.id]);
});
