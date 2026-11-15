const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The production module's routes, pinned before they left server.js: runs
// (list, create, get, delete), node status through to a completed run, batches,
// scrap, completed production runs, a machine's queue and an item's pipeline
// history. Stock put on a run is in run-stock-inputs.test.js, stage
// reconciliation in stage-reconciliations.test.js, assembly jobs in
// jobs-api.test.js.

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-production-api-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'production@example.test';
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
    body: JSON.stringify({ email: 'production@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body, withAuth = true) => fetch(`${baseUrl}${route}`, {
    method,
    headers: withAuth ? headers : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const template = await backend.get('SELECT * FROM pipeline_templates LIMIT 1');
  return { backend, server, api, template };
}

test('runs: create, list, get, delete, and the refusals', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, template } = ctx;

  assert.equal((await api('GET', '/runs', undefined, false)).status, 401, 'runs need a login');
  assert.equal((await api('POST', '/runs', { templateId: template.id }, false)).status, 401);

  const noTemplate = await api('POST', '/runs', {});
  assert.equal(noTemplate.status, 400);
  assert.equal(noTemplate.body.error, 'templateId is required.');
  const unknown = await api('POST', '/runs', { templateId: 'no-such-template' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'Template not found.');

  const made = await api('POST', '/runs', { templateId: template.id, name: 'Pinned Run' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = made.body.run;
  assert.ok(run.id);
  assert.equal(run.templateId, template.id);
  assert.equal(run.name, 'Pinned Run');
  assert.equal(typeof run.attachedBarcodeInputs, 'object');

  const listed = await api('GET', '/runs');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.runs.some((r) => r.id === run.id));
  const filtered = await api('GET', `/runs?template_id=${encodeURIComponent(template.id)}`);
  assert.ok(filtered.body.runs.every((r) => r.templateId === template.id));
  assert.ok(filtered.body.runs.some((r) => r.id === run.id));

  const got = await api('GET', `/runs/${run.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.run.id, run.id);
  const missing = await api('GET', '/runs/no-such-run');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Run not found.');

  const batches = await api('PUT', `/runs/${run.id}/batches`, { batches: [{ id: 'b1', quantity: 3 }] });
  assert.equal(batches.status, 200, JSON.stringify(batches.body));
  const stored = await ctx.backend.get('SELECT batches_json FROM pipeline_runs WHERE id = ?', [run.id]);
  assert.deepEqual(JSON.parse(stored.batches_json), [{ id: 'b1', quantity: 3 }]);
  assert.equal((await api('PUT', `/runs/${run.id}/batches`, {})).status, 400);
  assert.equal((await api('PUT', '/runs/no-such-run/batches', { batches: [] })).status, 404);

  assert.equal((await api('PUT', `/runs/${run.id}/node-metrics`, {})).status, 400);
  assert.equal((await api('PUT', '/runs/no-such-run/node-metrics', { nodeId: 'n', metrics: {} })).status, 404);

  // Deleting a run takes its inputs and scrap rows with it.
  await ctx.backend.run(
    `INSERT INTO production_scrap (pipeline_run_id, node_id, order_no, material_barcode, scrap_qty, logged_by)
     VALUES (?, 'n1', '', 'X', 1, 'test')`, [run.id]);
  const gone = await api('DELETE', `/runs/${run.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body, { success: true });
  assert.equal((await ctx.backend.get('SELECT COUNT(*) AS c FROM production_scrap WHERE pipeline_run_id = ?', [run.id])).c, 0);
  assert.equal((await api('GET', `/runs/${run.id}`)).status, 404);
  assert.equal((await api('DELETE', `/runs/${run.id}`)).status, 404);
});

test('node status: recorded with its overrides, and a run completes when every node is done', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, template, backend } = ctx;
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Status Run' })).body.run;
  const nodes = JSON.parse(template.nodes_json || '[]');
  assert.ok(nodes.length > 0, 'the demo template has nodes');

  assert.equal((await api('PUT', `/runs/${run.id}/node-status`, { nodeId: nodes[0].id })).status, 400);
  assert.equal((await api('PUT', '/runs/no-such-run/node-status', { nodeId: 'n', status: 'done' })).status, 404);

  const first = await api('PUT', `/runs/${run.id}/node-status`, {
    nodeId: nodes[0].id, status: 'active', actualDurationHours: 2.5, batchQuantity: 7, machineOverride: 'M-1',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const row = await backend.get('SELECT * FROM pipeline_runs WHERE id = ?', [run.id]);
  assert.equal(JSON.parse(row.node_status_json)[nodes[0].id], 'active');
  const overrides = JSON.parse(row.overrides_json);
  assert.equal(overrides.actualDurationHoursByNode[nodes[0].id], 2.5);
  assert.equal(overrides.batchQuantityByNode[nodes[0].id], 7);
  assert.equal(overrides.machineOverrideByNode[nodes[0].id], 'M-1');
  assert.notEqual(row.status, 'completed');

  for (const node of nodes) {
    const res = await api('PUT', `/runs/${run.id}/node-status`, { nodeId: node.id, status: 'done' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const done = await backend.get('SELECT status, completed_at FROM pipeline_runs WHERE id = ?', [run.id]);
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at);

  // Completing books the run as output once, under a code made from its whole id.
  const runCode = String(run.id).toUpperCase().startsWith('RUN-') ? String(run.id).toUpperCase() : `RUN-${String(run.id).toUpperCase()}`;
  const booked = await backend.all('SELECT * FROM production_runs WHERE run_code = ?', [runCode]);
  const again = await api('PUT', `/runs/${run.id}/node-status`, { nodeId: nodes[0].id, status: 'done' });
  assert.equal(again.status, 200);
  const bookedAfter = await backend.all('SELECT * FROM production_runs WHERE run_code = ?', [runCode]);
  assert.equal(bookedAfter.length, booked.length, 'setting a status again books nothing more');
  assert.ok(booked.length <= 1);
  if (booked.length === 1) {
    assert.equal(booked[0].status, 'completed');
    assert.equal(JSON.parse(booked[0].source_metadata_json).pipelineRunId, run.id);
    const completed = await api('GET', '/api/production-runs/completed');
    assert.equal(completed.status, 200);
    assert.ok(completed.body.data.some((r) => (r.runCode ?? r.run_code) === runCode));
    assert.deepEqual(completed.body.data, completed.body.productionRuns);
  }
});

test('scrap: logged against a run and read back by run and node', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, template } = ctx;
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Scrap Run' })).body.run;

  const missing = await api('POST', '/api/production-scrap', { pipelineRunId: run.id });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'pipelineRunId, nodeId, and materialBarcode are required.');

  const logged = await api('POST', '/api/production-scrap', {
    pipelineRunId: run.id, nodeId: 'node-1', orderNo: 'ORD-X', materialBarcode: 'no-such-barcode', scrapQty: 1.5,
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.deepEqual(logged.body, { success: true });

  const byRun = await api('GET', `/api/production-scrap?pipelineRunId=${run.id}`);
  assert.equal(byRun.status, 200);
  assert.equal(byRun.body.data.length, 1);
  assert.equal(byRun.body.data[0].node_id, 'node-1');
  assert.equal(byRun.body.data[0].scrap_qty, 1.5);
  const byNode = await api('GET', `/api/production-scrap?pipelineRunId=${run.id}&nodeId=other`);
  assert.equal(byNode.body.data.length, 0);
});

test('a machine queue lists the live runs that name it, and an item shows its pipeline history', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, template, backend } = ctx;

  assert.equal((await api('GET', '/api/machines/999999/queue')).status, 404);
  const machine = await backend.get('SELECT * FROM machines LIMIT 1');
  if (machine) {
    const run = (await api('POST', '/runs', { templateId: template.id, name: 'Queue Run' })).body.run;
    const nodes = JSON.parse(template.nodes_json || '[]');
    await api('PUT', `/runs/${run.id}/node-status`, {
      nodeId: nodes[0].id, status: 'active', machineOverride: String(machine.id),
    });
    const queue = await api('GET', `/api/machines/${machine.id}/queue`);
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.equal(queue.body.success, true);
    assert.ok(Array.isArray(queue.body.queue));
    assert.ok(
      queue.body.queue.some((entry) => JSON.stringify(entry).includes(run.id)),
      'the run that names this machine is in its queue',
    );
  }

  assert.equal((await api('GET', '/api/items/999999/pipeline-history')).status, 404);
  const item = await backend.get('SELECT * FROM items LIMIT 1');
  const history = await api('GET', `/api/items/${item.id}/pipeline-history`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.itemId, item.id);
  assert.ok(Array.isArray(history.body.runs));
  assert.ok(history.body.runs.every((r) => typeof r.pipelineName === 'string'));
});
