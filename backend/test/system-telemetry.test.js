'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const compression = require('compression');
const { makeTempDir } = require('./helpers/temp-dir');
const { createTelemetry } = require('../kernel/telemetry');

// Track 3: what the server is doing (kernel/telemetry.js) and what it is
// (kernel/system-routes.js), for the people who keep it running.

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/// The raw bytes a response put on the wire, without decoding them.
function rawGet(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes }));
    }).on('error', reject);
  });
}

test('per route, by pattern: durations, status classes, and the bytes that went on the wire', async (t) => {
  const telemetry = createTelemetry({ checkpointEveryMs: 0 });
  const app = express();
  app.use(telemetry.middleware);
  app.use(compression());
  const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `part ${i}` })) });
  app.get('/api/parts/:id', (req, res) => {
    if (req.params.id === 'missing') return res.status(404).json({ error: 'none' });
    return res.type('application/json').send(big);
  });
  app.get('/api/events', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: {}\n\n');
  });
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const wire = await rawGet(port, '/api/parts/1', { 'Accept-Encoding': 'gzip' });
  await rawGet(port, '/api/parts/2', { 'Accept-Encoding': 'gzip' });
  await rawGet(port, '/api/parts/missing');
  await rawGet(port, '/api/nowhere');
  await rawGet(port, '/api/events');
  await new Promise((resolve) => setImmediate(resolve));

  const snap = telemetry.snapshot();
  const parts = snap.requests.routes['GET /api/parts/:id'];
  assert.ok(parts, `routes: ${Object.keys(snap.requests.routes)}`);
  assert.equal(parts.count, 3, 'one row for the pattern, not one per id');
  assert.deepEqual(parts.status, { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 0 });
  assert.ok(wire.bytes < big.length, 'the body was compressed');
  assert.ok(parts.bytesOut >= wire.bytes * 2 && parts.bytesOut < big.length, `counted ${parts.bytesOut}, the compressed size, not ${big.length * 2}`);
  assert.ok(parts.p50 >= 0 && parts.p99 >= parts.p50);
  assert.equal(snap.requests.routes.unmatched.status['4xx'], 1);
  assert.equal(snap.requests.routes['GET /api/events'], undefined, 'the event stream is not a request duration');

  const text = telemetry.prometheus(snap);
  assert.match(text, /# TYPE paper_http_request_duration_ms histogram/);
  assert.match(text, /paper_http_request_duration_ms_bucket\{route="GET \/api\/parts\/:id",le="\+Inf"\} 3/);
  assert.match(text, /paper_http_requests_total\{route="GET \/api\/parts\/:id",status="4xx"\} 1/);
});

test('percentiles are nearest-rank over the kept window', () => {
  const telemetry = createTelemetry({ checkpointEveryMs: 0 });
  let clock = 0n;
  const timed = createTelemetry({ now: () => clock, checkpointEveryMs: 0 });
  for (let ms = 1; ms <= 100; ms += 1) {
    timed.timedWrite('main', 'INSERT INTO t VALUES (1)', (done) => {
      clock += BigInt(ms) * 1000000n;
      done();
    });
  }
  timed.timedWrite('main', 'SELECT 1', (done) => done());
  const writes = timed.snapshot().sqlite.writes;
  assert.equal(writes.count, 100, 'reads are not writes');
  assert.deepEqual([writes.p50, writes.p95, writes.p99], [50, 95, 99]);
  assert.equal(telemetry.snapshot().sqlite.writes.p50, null, 'nothing measured is null, not zero');
});

test('write lock wait is the time a write was not executing', () => {
  let clock = 0n;
  const telemetry = createTelemetry({ now: () => clock, checkpointEveryMs: 0 });
  // Before profiling is on (the schema setup at boot): timed, but no execution
  // time arrives, so the wait cannot be known.
  telemetry.timedWrite('main', 'CREATE TABLE t (id INTEGER)', (done) => {
    clock += 50n * 1000000n;
    done();
  });
  assert.equal(telemetry.snapshot().sqlite.lockWaitMsTotal, null, 'no profile hook: the wait is unknown, not all of it');

  telemetry.watchConnection({ on() {}, removeListener() {} });
  assert.equal(telemetry.snapshot().sqlite.lockWaitMsTotal, 0,
    'the boot writes have no execution time to subtract: they are not counted as waiting');

  telemetry.timedWrite('main', 'UPDATE items SET name = ?', (done) => {
    clock += 30n * 1000000n; // 30 ms from hand-off to callback
    telemetry.onProfile('UPDATE items SET name = ?', 4); // of which SQLite ran it for 4
    done();
  });
  telemetry.timedWrite('delete', 'DELETE FROM items', (done) => {
    clock += 10n * 1000000n;
    telemetry.onProfile('DELETE FROM items', 10);
    done(Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }));
  });
  const sqlite = telemetry.snapshot().sqlite;
  assert.equal(sqlite.elapsedMsTotal, 90);
  assert.equal(sqlite.execMsTotal, 14);
  assert.equal(sqlite.lockWaitMsTotal, 26);
  assert.equal(sqlite.profiledWrites, 2);
  assert.equal(sqlite.lockWaitMsPerWrite, 13);
  assert.equal(sqlite.writes.count, 3, 'every write is still counted and timed');
  assert.equal(sqlite.busyErrors, 1);
  assert.deepEqual(sqlite.byConnection, { main: 2, delete: 1 });
});


async function boot(t) {
  const tempDir = makeTempDir('paper-telemetry-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'ops@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  process.env.PAPER_METRICS_TOKEN = 'scrape-token-for-tests-0123456789';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  delete process.env.PAPER_METRICS_TOKEN;
  backend.startServerTelemetry();
  t.after(() => backend.stopServerTelemetry());
  await backend.resetAndSeedDemoData('scenario_a');
  const server = await listen(backend.app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json())).token;
  const owner = await login('ops@paper.test', 'OwnerPass1234');
  const as = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  return { backend, baseUrl, owner, as, login, tempDir };
}

test('GET /api/system/metrics: an admin or the scrape token, nobody else', async (t) => {
  const ctx = await boot(t);
  const made = await fetch(`${ctx.baseUrl}/api/users`, {
    method: 'POST',
    headers: ctx.as(ctx.owner),
    body: JSON.stringify({ name: 'Floor Clerk', email: 'clerk@paper.test', password: 'ClerkPass1234', role: 'user', permissions: ['login.desktop'] }),
  });
  assert.equal(made.status, 201, await made.clone().text());
  const clerk = await ctx.login('clerk@paper.test', 'ClerkPass1234');

  assert.equal((await fetch(`${ctx.baseUrl}/api/system/metrics`)).status, 401);
  assert.equal((await fetch(`${ctx.baseUrl}/api/system/metrics`, { headers: ctx.as(clerk) })).status, 403);
  assert.equal((await fetch(`${ctx.baseUrl}/api/system/metrics`, { headers: { Authorization: 'Bearer not-the-token' } })).status, 401);

  await fetch(`${ctx.baseUrl}/api/items`, { headers: ctx.as(ctx.owner) });
  const metrics = await fetch(`${ctx.baseUrl}/api/system/metrics`, { headers: ctx.as(ctx.owner) });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.headers.get('cache-control'), 'no-store');
  const body = await metrics.json();
  const items = body.requests.routes['GET /api/items'];
  assert.ok(items && items.count >= 1 && items.status['2xx'] >= 1, JSON.stringify(Object.keys(body.requests.routes)));
  assert.ok(body.requests.routes['POST /api/auth/login'].bytesIn > 0, 'request bodies are counted');
  assert.ok(body.sqlite.writes.count > 0, 'seeding and signing in wrote');
  assert.ok(body.sqlite.execMsTotal > 0, 'the profile hook reports execution time');
  assert.ok(body.files.db > 0 && body.files.wal >= 0);

  const scraped = await fetch(`${ctx.baseUrl}/api/system/metrics?format=prometheus`, {
    headers: { Authorization: 'Bearer scrape-token-for-tests-0123456789' },
  });
  assert.equal(scraped.status, 200);
  assert.match(scraped.headers.get('content-type'), /text\/plain/);
  const text = await scraped.text();
  assert.match(text, /paper_http_requests_total\{route="GET \/api\/items",status="2xx"\} [1-9]/);
  assert.match(text, /paper_db_file_bytes\{file="db"\} [1-9]/);
});

test('the WAL checkpoint is timed and reports the pages it moved', async (t) => {
  const ctx = await boot(t);
  const result = await ctx.backend.serverTelemetry.checkpoint(ctx.backend.get);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.ok(result.logPages >= 0 && result.checkpointedPages >= 0, JSON.stringify(result));
  assert.ok(result.durationMs >= 0);
  const body = await fetch(`${ctx.baseUrl}/api/system/metrics`, { headers: ctx.as(ctx.owner) }).then((r) => r.json());
  assert.ok(body.walCheckpoint.runs >= 1);
  assert.deepEqual(body.walCheckpoint.last, result);
});

test('GET /api/system/status: any signed-in user, the changelog head, the compatibility window', async (t) => {
  const ctx = await boot(t);
  assert.equal((await fetch(`${ctx.baseUrl}/api/system/status`)).status, 401);
  const status = await fetch(`${ctx.baseUrl}/api/system/status`, { headers: ctx.as(ctx.owner) });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('cache-control'), 'no-store', 'a cached answer would fake a ping');
  const body = await status.json();
  const head = Number((await ctx.backend.get('SELECT MAX(id) AS n FROM changelog')).n || 0);
  assert.equal(body.changelogHead, head);
  assert.ok(head > 0, 'the seed wrote through the changelog');
  assert.equal(body.apiVersion, 1);
  assert.equal(body.minClientApiVersion, body.apiVersion - 1);
  assert.equal(typeof body.serverVersion, 'string');
  assert.ok(Date.parse(body.serverTime));
});
