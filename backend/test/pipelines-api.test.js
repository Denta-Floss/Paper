const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Pipeline templates, which the server answers on TWO sets of routes that do
// not behave the same:
//
//   /api/production/pipeline-templates   the app's own: upsert on POST, version
//                                        set from the body, delete refused while
//                                        a run uses the template, Track entries
//   /templates                           the older root set: POST needs id+name,
//                                        PUT bumps the version, delete has no
//                                        run check, no Track entries
//
// Both are pinned as they are; merging them is a separate decision. The root set
// sits outside /api, behind its own auth gates.
//
// sheet-plan-persistence.test.js and assembly-job-dedupe.test.js use these
// routes as plumbing; this file is about the routes themselves.
//
// Written before the pipelines code left server.js.

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-pipelines-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'pipelines@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pipelines@example.test', password: 'OwnerPass1234' }),
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

function template(id, extra = {}) {
  return {
    id,
    name: `Template ${id}`,
    factoryId: 'f1',
    stageLabels: ['Input', 'Output'],
    laneLabels: ['Lane 1'],
    nodes: [{ id: 'n1', name: 'Input', processType: 'Input' }],
    flows: [],
    ...extra,
  };
}

test('pipelines (api): save, read back, update, and list by factory', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const saved = await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-1', { version: 3 }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.template.id, 'tpl-api-1');
  assert.equal(saved.body.template.version, 3, 'the version is whatever the body says');
  assert.equal(saved.body.template.status, 'draft');
  assert.deepEqual(saved.body.template.stageLabels, ['Input', 'Output']);
  assert.equal(saved.body.template.nodes.length, 1);

  const again = await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-1', { name: 'Renamed' }));
  assert.equal(again.status, 200);
  assert.equal(again.body.template.name, 'Renamed', 'a second POST with the same id replaces it');

  await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-2', { factoryId: 'f2' }));
  await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-3', { factoryId: '' }));
  const all = await api(ctx, 'GET', '/api/production/pipeline-templates');
  const ids = all.body.templates.map((x) => x.id);
  assert.ok(ids.includes('tpl-api-1') && ids.includes('tpl-api-2') && ids.includes('tpl-api-3'));
  const f1 = await api(ctx, 'GET', '/api/production/pipeline-templates?factoryId=f1');
  const f1ids = f1.body.templates.map((x) => x.id);
  assert.ok(f1ids.includes('tpl-api-1'), 'its own factory');
  assert.ok(f1ids.includes('tpl-api-3'), 'and the shared ones with no factory');
  assert.ok(!f1ids.includes('tpl-api-2'), 'but not another factory\'s');

  const put = await api(ctx, 'PUT', '/api/production/pipeline-templates/tpl-api-1', { description: 'Now described' });
  assert.equal(put.status, 200);
  assert.equal(put.body.template.description, 'Now described');
  assert.equal(put.body.template.name, 'Renamed', 'what a PUT leaves out is kept');
  assert.equal(put.body.template.nodes.length, 1);
  assert.equal(put.body.template.version, 1, 'and its version falls back to 1, not to what it was');

  const ghost = await api(ctx, 'PUT', '/api/production/pipeline-templates/nope', { name: 'x' });
  assert.equal(ghost.status, 404);
});

test('pipelines (api): a template with runs cannot be deleted, one without can', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-held'));
  await api(ctx, 'POST', '/api/production/pipeline-templates', template('tpl-api-free'));
  await ctx.backend.run(
    `INSERT INTO pipeline_runs (id, template_id, template_version, name, status) VALUES ('run-pl-1', 'tpl-api-held', 1, 'Run', 'completed')`,
  );

  const refused = await api(ctx, 'DELETE', '/api/production/pipeline-templates/tpl-api-held');
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /ongoing or historical runs/);

  const gone = await api(ctx, 'DELETE', '/api/production/pipeline-templates/tpl-api-free');
  assert.equal(gone.status, 200);
  const list = await api(ctx, 'GET', '/api/production/pipeline-templates');
  assert.ok(!list.body.templates.some((x) => x.id === 'tpl-api-free'));
  assert.ok(list.body.templates.some((x) => x.id === 'tpl-api-held'));
});

test('pipelines (root): create, read, update bumps the version, delete', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  assert.equal((await api(ctx, 'POST', '/templates', { name: 'No id' })).status, 400);
  assert.equal((await api(ctx, 'POST', '/templates', { id: 'tpl-root-x' })).status, 400);

  const made = await api(ctx, 'POST', '/templates', template('tpl-root-1'));
  assert.equal(made.status, 201);
  assert.equal(made.body.template.version, 1, 'the root set always starts at version 1');

  const one = await api(ctx, 'GET', '/templates/tpl-root-1');
  assert.equal(one.status, 200);
  assert.equal(one.body.template.name, 'Template tpl-root-1');
  assert.equal((await api(ctx, 'GET', '/templates/nope')).status, 404);

  const list = await api(ctx, 'GET', '/templates');
  assert.ok(list.body.templates.some((x) => x.id === 'tpl-root-1'));

  const put = await api(ctx, 'PUT', '/templates/tpl-root-1', { description: 'Edited' });
  assert.equal(put.status, 200);
  assert.equal(put.body.template.version, 2, 'every PUT bumps the version');
  assert.equal(put.body.template.description, 'Edited');
  assert.equal(put.body.template.name, 'Template tpl-root-1');
  assert.equal(put.body.template.nodes.length, 1, 'what a PUT leaves out is kept');
  assert.equal((await api(ctx, 'PUT', '/templates/nope', { name: 'x' })).status, 404);
  assert.equal((await api(ctx, 'PUT', '/templates/tpl-root-1', {})).body.template.version, 3);

  assert.equal((await api(ctx, 'DELETE', '/templates/nope')).status, 404);
  assert.equal((await api(ctx, 'DELETE', '/templates/tpl-root-1')).status, 200);
  assert.equal((await api(ctx, 'GET', '/templates/tpl-root-1')).status, 404);
});

test('pipelines (root): sits behind its own auth gate and has no run check on delete', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const anonymous = await fetch(`${ctx.baseUrl}/templates`);
  assert.equal(anonymous.status, 401);
  const anonymousWrite = await fetch(`${ctx.baseUrl}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template('tpl-root-anon')),
  });
  assert.equal(anonymousWrite.status, 401);

  await api(ctx, 'POST', '/templates', template('tpl-root-held'));
  await ctx.backend.run(
    `INSERT INTO pipeline_runs (id, template_id, template_version, name, status) VALUES ('run-pl-2', 'tpl-root-held', 1, 'Run', 'completed')`,
  );
  await ctx.backend.run('PRAGMA foreign_keys = OFF');
  const removed = await api(ctx, 'DELETE', '/templates/tpl-root-held');
  assert.equal(removed.status, 200, 'unlike the api route, the root one does not look at runs');
});
