const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// Writes across modules are one unit or nothing (stage 2c). Recording scrap on
// a run writes production's scrap row, mints a lot in inventory, moves stock
// into it and raises a note in challans. If the last of those fails, none of
// the others may remain.

async function boot() {
  const tempDir = makeTempDir('paper-atomic-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'atomic@example.test';
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
    body: JSON.stringify({ email: 'atomic@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) =>
    fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { backend, desk: backend.desk, server, api };
}

test('scrap recorded on a run is written whole or not at all', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { backend, api } = ctx;

  const template = await backend.get('SELECT id FROM pipeline_templates ORDER BY id LIMIT 1');
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Scrap Atomic' })).body.run;
  const material = (await api('POST', '/api/materials/parent', {
    name: 'Scrap Source', type: 'Sheet', numberOfChildren: 1, unit: 'Kg',
  })).body.material;
  const counts = async () => ({
    scrap: (await backend.get('SELECT COUNT(*) AS n FROM production_scrap WHERE pipeline_run_id = ?', [run.id])).n,
    lots: (await backend.get("SELECT COUNT(*) AS n FROM materials WHERE barcode LIKE 'LOT-SCRAP-%'")).n,
    moves: (await backend.get("SELECT COUNT(*) AS n FROM inventory_movements WHERE reference_type = 'pipeline_scrap' AND reference_id = ?", [run.id])).n,
    notes: (await backend.get("SELECT COUNT(*) AS n FROM delivery_challans WHERE source_reference LIKE ?", [`Scrap/Run ${run.id}/%`])).n,
  });
  assert.deepEqual(await counts(), { scrap: 0, lots: 0, moves: 0, notes: 0 });

  // The last step, raising the note in challans, fails.
  ctx.desk.trip('challans.stageNotes.create', new Error('challans is down'));
  const failed = await api('POST', '/api/production-scrap', {
    pipelineRunId: run.id, nodeId: 'n1', materialBarcode: material.barcode, scrapQty: 2,
  });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.match(failed.body.error, /challans is down/);
  assert.deepEqual(await counts(), { scrap: 0, lots: 0, moves: 0, notes: 0 }, 'nothing of the half-done scrap remains');

  // The same request with nothing in the way writes all four.
  const ok = await api('POST', '/api/production-scrap', {
    pipelineRunId: run.id, nodeId: 'n1', materialBarcode: material.barcode, scrapQty: 2,
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(await counts(), { scrap: 1, lots: 1, moves: 1, notes: 1 });
});

test('a job is removed with its tasks or kept with them', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const item = await ctx.backend.get('SELECT id FROM items ORDER BY id LIMIT 1');
  const job = (await ctx.api('POST', '/api/freelancer-jobs', { item_id: item.id, quantity: 3 })).body.job;
  await ctx.backend.run('INSERT INTO freelancer_job_tasks (job_id, item_id, required_quantity, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    [job.id, item.id, new Date().toISOString(), new Date().toISOString()]).catch(() => {});
  const gone = await ctx.api('DELETE', `/api/freelancer-jobs/${job.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal((await ctx.backend.get('SELECT COUNT(*) AS n FROM freelancer_jobs WHERE id = ?', [job.id])).n, 0);
  assert.equal((await ctx.backend.get('SELECT COUNT(*) AS n FROM freelancer_job_tasks WHERE job_id = ?', [job.id])).n, 0);
});
