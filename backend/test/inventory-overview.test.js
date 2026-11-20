'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// GET /api/inventory/overview: the inventory screen's four reads in one answer.
//
// It is only safe to switch the app to it if every part is exactly what its
// own endpoint answers — the app parses each part with the parser it already
// had. So this compares them, part by part, on the same data.

async function boot() {
  const tempDir = makeTempDir('paper-inv-overview-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'overview@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData('scenario_a');
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'overview@paper.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { Authorization: `Bearer ${login.token}` };
  const getJson = (route) => fetch(`${baseUrl}${route}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { backend, server, port, headers, getJson };
}

// See wire-weight.test.js: fetch turns a manual If-None-Match into a forced
// revalidation, so a conditional GET has to be a plain request.
function rawGet(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('every part of the overview is what its own endpoint answers', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));

  const overview = await ctx.getJson('/api/inventory/overview');
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.body.success, true);

  const materials = await ctx.getJson('/api/materials');
  const stock = await ctx.getJson('/api/inventory/stock');
  const sets = await ctx.getJson('/api/inventory/sets');
  const health = await ctx.getJson('/api/inventory/health');

  assert.ok(materials.body.materials.length > 0, 'the scenario has materials to compare');
  assert.ok(stock.body.stock.length > 0, 'and stock');
  assert.deepEqual(overview.body.materials, materials.body.materials);
  assert.deepEqual(overview.body.stock, stock.body.stock);
  assert.deepEqual(overview.body.sets, sets.body.sets);
  assert.deepEqual(overview.body.health, health.body.health);
  assert.equal(overview.body.healthError, null);
});

test('?materials=0 leaves the materials out and nothing else', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));

  const full = await ctx.getJson('/api/inventory/overview');
  const lean = await ctx.getJson('/api/inventory/overview?materials=0');
  assert.equal(lean.status, 200);
  assert.ok(!('materials' in lean.body), 'no materials key, so a client cannot mistake it for an empty list');
  assert.deepEqual(lean.body.stock, full.body.stock);
  assert.deepEqual(lean.body.sets, full.body.sets);
  assert.deepEqual(lean.body.health, full.body.health);
});

test('an unchanged overview costs a header, and a change gets the new answer', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));

  const first = await rawGet(ctx.port, '/api/inventory/overview', ctx.headers);
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag, 'a validator is issued');
  assert.match(first.headers['cache-control'] || '', /must-revalidate/);

  const again = await rawGet(ctx.port, '/api/inventory/overview', { ...ctx.headers, 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304, 'the tiles hold no clock, so the same data hashes the same');

  // A movement changes stock; the old validator must stop matching.
  const material = (await ctx.getJson('/api/materials')).body.materials.find((m) => Number(m.onHand ?? m.on_hand_qty ?? 0) >= 0);
  const moved = await fetch(`http://127.0.0.1:${ctx.port}/api/inventory/movements`, {
    method: 'POST',
    headers: { ...ctx.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ barcode: material.barcode, movementType: 'receive', qty: 3, referenceType: 'manual', referenceId: 'OVERVIEW-TEST' }),
  });
  assert.ok(moved.status < 300, `the movement lands (${moved.status} ${await moved.text()})`);

  const after = await rawGet(ctx.port, '/api/inventory/overview', { ...ctx.headers, 'If-None-Match': first.headers.etag });
  assert.equal(after.status, 200, 'a stale validator gets the new answer');
  assert.ok(after.body.length > 0);
});
