const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { answered } = require('../modules/production/operations');

// Production behind the kernel desk.
//
// production-api, run-stock-inputs, production-order-links and the journey
// tests pin every HTTP answer, and they passed unchanged when the fifteen
// handlers' bodies were moved into modules/production/work.js. This file pins
// what is new: an answer survives the trip through a result and back, the
// operations ask what each route's own guard asked, and the modules that were
// handed production's ports now ask the desk for exactly what they declared.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-production-ops-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'floor@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'floor@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) =>
    fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const template = await backend.get('SELECT * FROM pipeline_templates ORDER BY id LIMIT 1');
  assert.ok(template, 'the demo data has a pipeline template');
  return { backend, desk: backend.desk, server, api, template };
}

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('an answer becomes a result and comes back as the same answer', () => {
  // What routes.js does with a result, in one place.
  const back = (result) => {
    const { ok, status, httpStatus, ...body } = result;
    return { status: ok ? httpStatus || 200 : status || 400, body: { success: ok, ...body } };
  };
  for (const answer of [
    { status: 200, body: { success: true, run: { id: 'r1', status: 'planned' } } },
    { status: 201, body: { success: true, run: { id: 'r2' } } },
    { status: 404, body: { success: false, run: null, error: 'Run not found.' } },
    { status: 400, body: { success: false, run: null, code: 'invalid_allocation', error: 'No.' } },
    { status: 500, body: { success: false, data: [], productionRuns: [], message: 'x', error: 'x' } },
    // The two would only disagree by mistake, and even then nothing is lost.
    { status: 200, body: { success: false, error: 'said no, politely' } },
  ]) {
    const result = answered(answer);
    assert.equal(result.ok, answer.status < 400);
    assert.deepEqual(back(result), answer);
  }
});

test('a run is the same run through the desk and over HTTP', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const made = await ctx.desk.call('production.runs.start', {
    data: { templateId: ctx.template.id, name: 'Desk Run' },
  }, system);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.httpStatus, 201);
  const runId = made.run.id;

  const viaHttp = await ctx.api('GET', `/runs/${runId}`);
  const viaDesk = await ctx.desk.call('production.runs.get', { runId }, system);
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(viaHttp.body.run, plain(viaDesk.run));

  const listHttp = await ctx.api('GET', `/runs?template_id=${encodeURIComponent(ctx.template.id)}`);
  const listDesk = await ctx.desk.call('production.runs.list', { templateId: ctx.template.id }, system);
  assert.deepEqual(listHttp.body.runs, plain(listDesk.runs));
  assert.ok(listDesk.runs.some((run) => run.id === runId));

  // Refusals keep their status and every field.
  assert.deepEqual(await ctx.desk.call('production.runs.start', { data: {} }, system), {
    ok: false, status: 400, run: null, error: 'templateId is required.',
  });
  const missing = await ctx.api('GET', '/runs/no-such-run');
  const missingDesk = await ctx.desk.call('production.runs.get', { runId: 'no-such-run' }, system);
  assert.equal(missing.status, missingDesk.status);
  assert.deepEqual(missing.body, { success: false, ...(({ ok, status, ...rest }) => rest)(missingDesk) });

  const gone = await ctx.desk.call('production.runs.delete', { runId }, system);
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal((await ctx.api('GET', `/runs/${runId}`)).status, 404);
});

test('each operation asks what its route’s own guard asked', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const as = (role, permissions = {}) => ({ actor: { kind: 'user', user: { id: 70, role, name: 'Tester' }, permissions } });
  const code = async (name, input, who) => (await ctx.desk.call(name, input, who)).code;
  const start = { data: { templateId: ctx.template.id, name: 'Guarded' } };

  // The /runs set: any signed-in user reads; config.write changes.
  assert.equal((await ctx.desk.call('production.runs.list', {}, as('user'))).ok, true);
  assert.equal(await code('production.runs.start', start, as('user')), 'forbidden');
  assert.equal(await code('production.runs.start', start, as('user', { 'inventory.update': true })), 'forbidden');
  assert.equal(await code('production.runs.start', start, as('user', { 'production.create': true })), 'forbidden');
  assert.equal((await ctx.desk.call('production.runs.start', start, as('user', { 'config.write': true }))).ok, true);

  // Scrap sits under a path no module claims: the old write gate decides.
  assert.equal((await ctx.desk.call('production.scrap.list', {}, as('user'))).ok, true);
  assert.equal(await code('production.scrap.record', { data: {} }, as('user')), 'forbidden');
  const let_through = await ctx.desk.call('production.scrap.record', { data: {} }, as('user', { 'inventory.update': true }));
  assert.notEqual(let_through.code, 'forbidden');

  // The gate goes by the first path segment, so a machine's queue is a
  // machines read and an item's history an items read.
  assert.equal(await code('production.machines.queue', { machineId: 1 }, as('user', { 'production.read': true })), 'forbidden');
  assert.notEqual(await code('production.machines.queue', { machineId: 1 }, as('user', { 'machines.read': true })), 'forbidden');
  assert.equal(await code('production.items.pipelineHistory', { itemId: 1 }, as('user', { 'production.read': true })), 'forbidden');
  assert.equal(await code('production.output.completed', {}, as('user', { 'machines.read': true })), 'forbidden');
  assert.equal((await ctx.desk.call('production.output.completed', {}, as('user', { 'production.read': true }))).ok, true);

  // Nothing a user can reach is one of the internal operations.
  assert.equal(await code('production.runs.dissolve', { runId: 'x' }, as('super_admin')), 'operation_internal');
});

test('the modules that were handed production’s ports ask the desk, for what they declared', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const run = (await ctx.api('POST', '/runs', { templateId: ctx.template.id, name: 'Asked Run' })).body.run;

  // Inventory and challans read a run; machines, dies and pipelines ask
  // before they delete.
  assert.equal((await ctx.desk.as('inventory').ask('production.runs.row', { runId: run.id })).row.id, run.id);
  assert.deepEqual((await ctx.desk.as('inventory').ask('production.runs.stages', { runId: run.id })).stages, []);
  assert.equal((await ctx.desk.as('inventory').ask('production.runs.inputCountForBarcode', { barcode: 'NOPE' })).count, 0);
  assert.deepEqual((await ctx.desk.as('challans').ask('production.challanLines.runInputs', { lineIds: [] })).rows, []);
  assert.equal((await ctx.desk.as('machines').ask('production.machines.assignedToActiveRun', { machineId: '999999' })).assigned, false);
  assert.equal((await ctx.desk.as('dies').ask('production.dies.assignedToActiveRun', { dieId: '999999' })).assigned, false);
  assert.ok((await ctx.desk.as('pipelines').ask('production.templates.runCount', { templateId: ctx.template.id })).count >= 1);

  // A template a run was started from is kept, as before.
  const kept = await ctx.api('DELETE', `/api/production/pipeline-templates/${encodeURIComponent(ctx.template.id)}`);
  assert.equal(kept.status, 400);
  assert.match(kept.body.error, /ongoing or historical runs/);

  // Only orders may dissolve a run, and it says it must be inside the
  // caller's transaction.
  assert.equal((await ctx.desk.as('inventory').call('production.runs.dissolve', { runId: run.id })).code, 'not_declared');
  assert.equal((await ctx.desk.as('clients').call('production.runs.row', { runId: run.id })).code, 'not_declared');
  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  assert.equal(listed['production.runs.dissolve'].joinsCallerTransaction, true);
  assert.deepEqual(listed['production.runs.dissolve'].usedBy, ['orders']);
  assert.equal(listed['production.runs.unlinkOrderItem'].joinsCallerTransaction, true);

  // …and production asks its own neighbours instead of reading their tables.
  const row = (await ctx.desk.as('production').ask('pipelines.templates.row', { id: ctx.template.id })).row;
  assert.equal(row.id, ctx.template.id);
  assert.equal((await ctx.desk.as('production').ask('machines.rows.get', { id: 999999 })).row, undefined);
  assert.equal((await ctx.desk.as('production').call('clients.rows.get', { id: 1 })).code, 'not_declared');

  // Ordinary use above broke none of production's contracts.
  const broken = Object.entries(ctx.desk.violationCounts()).filter(([name]) => name.startsWith('production.'));
  assert.deepEqual(broken, []);
});
