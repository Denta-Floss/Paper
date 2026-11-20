'use strict';

// Sign-in and screen loads over a modelled shop-floor link, many times, with
// their tail latencies asserted against the SLOs and written up as a report.
//
//   node test/benchmarks/network-throttle.js            50 runs, writes the report
//   node test/benchmarks/network-throttle.js --runs 5   a quick look
//   options: --runs N  --baseline-runs N  --report PATH  --no-report
//
// Not part of `npm test` (it takes minutes); `npm run bench:network` runs it.
// The link is test/benchmarks/throttle-proxy.js — read its header for what is
// and is not modelled. The server runs in this process on a workspace filled
// to a few hundred rows per master (test/helpers/sized-workspace.js).
//
// What each scenario replays is what the apps do today, request for request:
//
//   sign_in_cold     first launch on a machine: sign in; the replica bootstrap;
//                    the screens wait for it (at most 3 s) and then fetch only
//                    what the replica does not hold
//   sign_in_warm     a relaunch: sign in; one /api/changes from the cursor;
//                    the same un-replicated reads, revalidated with the ETags
//                    the response cache kept from last time
//   inventory_overview, orders_list, items_list
//                    a refresh inside a session: one full answer on a
//                    connection already open
//   baseline_august  the request pattern before the wire work (no gzip, the
//                    providers' chained calls, thirteen replica lists one after
//                    another), replayed against today's server. A model of
//                    then, not a recording: today's endpoints are already
//                    slimmer than August's were.

const fs = require('node:fs');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const { createThrottledLink } = require('./throttle-proxy');
const { fillWorkspace } = require('../helpers/sized-workspace');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const RUNS = Number(option('runs', 50));
const BASELINE_RUNS = Number(option('baseline-runs', 10));
const REPORT = args.includes('--no-report')
  ? null
  : path.resolve(__dirname, '../../..', option('report', 'Docs/benchmarks/2026-11-constrained-network-results.md'));

const PROFILES = [
  { name: '1 Mbps, 150 ms RTT', key: '1mbps', bandwidthBps: 1e6, rttMs: 150, lossRate: 0 },
  { name: '2 Mbps, 150 ms RTT', key: '2mbps', bandwidthBps: 2e6, rttMs: 150, lossRate: 0 },
  { name: '1 Mbps, 150 ms RTT, 2% loss', key: '1mbps-loss', bandwidthBps: 1e6, rttMs: 150, lossRate: 0.02 },
];

// The SLOs, on the 1 Mbps link without loss. Loss and 2 Mbps are reported.
const SLOS = [
  { scenario: 'sign_in_cold', profile: '1mbps', p: 95, limitMs: 5000 },
  { scenario: 'sign_in_warm', profile: '1mbps', p: 95, limitMs: 5000 },
  { scenario: 'inventory_overview', profile: '1mbps', p: 95, limitMs: 1500 },
  { scenario: 'orders_list', profile: '1mbps', p: 95, limitMs: 2000 },
];
const SERVER_P99_LIMIT_MS = 25;

// What the desktop fetches over the network once its replica is hydrated: the
// reads it does not replicate (lib/main.dart's providers, traced 2026-11-19).
const UNREPLICATED = [
  '/api/inventory/overview?materials=0',
  '/api/units/gauge-table',
  '/api/company-profile',
  '/api/employees',
  '/api/freelancer-jobs',
  '/api/action-center/issues',
  '/api/trash',
  '/api/app/latest',
];

// The August start-up: each provider's calls in the order it awaited them.
const AUGUST_PROVIDERS = [
  ['/api/orders'],
  ['/api/materials', '/api/inventory/stock', '/api/inventory/sets', '/api/inventory/health'],
  ['/api/units', '/api/units/gauge-table'],
  ['/api/groups'],
  ['/api/clients'],
  ['/api/vendors'],
  ['/api/items'],
  ['/api/company-profile'],
  ['/api/challans'],
  ['/api/machines'],
  ['/api/dies'],
  ['/api/departments'],
  ['/api/employees'],
  ['/api/freelancer-jobs'],
  ['/api/action-center/issues', '/api/trash'],
  ['/api/app/latest'],
];
const AUGUST_REPLICA = [
  '/api/items', '/api/challans', '/api/orders', '/api/materials', '/api/clients', '/api/vendors',
  '/api/machines', '/api/dies', '/api/units', '/api/groups', '/api/departments',
  '/api/production/pipeline-templates', '/runs', '/api/changes?since=0',
];

const EMAIL = 'bench@paper.test';
const PASSWORD = 'OwnerPass1234';

function request(port, { method = 'GET', path: urlPath, body, headers = {}, agent, gzip = true }) {
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      agent,
      headers: {
        ...(gzip ? { 'Accept-Encoding': 'gzip' } : { 'Accept-Encoding': 'identity' }),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const firstByte = Number(process.hrtime.bigint() - started) / 1e6;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bytes: chunks.reduce((sum, c) => sum + c.length, 0),
        body: Buffer.concat(chunks),
        firstByteMs: firstByte,
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/// The body as JSON, unzipped when it travelled zipped.
function json(answer) {
  const raw = answer.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(answer.body) : answer.body;
  return JSON.parse(raw.toString('utf8'));
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

const freshAgent = () => new http.Agent({ keepAlive: true, maxSockets: Infinity });

// --- the scenarios ---------------------------------------------------------

async function signIn(port, agent, gzip = true) {
  const answer = await request(port, {
    method: 'POST', path: '/api/auth/login', body: { email: EMAIL, password: PASSWORD }, agent, gzip,
  });
  const token = json(answer).token;
  return { token, answer };
}

async function signInCold(port) {
  const agent = freshAgent();
  const started = Date.now();
  const log = [];
  const { token, answer } = await signIn(port, agent);
  log.push(answer);
  const auth = { Authorization: `Bearer ${token}` };
  const bootstrap = request(port, { path: '/api/replica/bootstrap', headers: auth, agent }).then((r) => { log.push(r); return r; });
  // The screens wait for the copy, three seconds at most.
  const waited = await Promise.race([bootstrap.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  const reads = waited ? UNREPLICATED : [...UNREPLICATED, ...AUGUST_PROVIDERS.flat()];
  const answers = await Promise.all(reads.map((p) => request(port, { path: p, headers: auth, agent })));
  log.push(...answers);
  await bootstrap;
  agent.destroy();
  return { ms: Date.now() - started, answers: log, hydratedInTime: waited };
}

async function signInWarm(port, etags) {
  const agent = freshAgent();
  const started = Date.now();
  const { token, answer } = await signIn(port, agent);
  const auth = { Authorization: `Bearer ${token}` };
  const head = await request(port, { path: `/api/changes?since=${etags.head}`, headers: auth, agent });
  const answers = await Promise.all(UNREPLICATED.map((p) => request(port, {
    path: p,
    headers: { ...auth, ...(etags.byPath[p] ? { 'If-None-Match': etags.byPath[p] } : {}) },
    agent,
  })));
  agent.destroy();
  return { ms: Date.now() - started, answers: [answer, head, ...answers] };
}

async function oneList(port, listPath) {
  const agent = freshAgent();
  // Signed in on this connection first: it is then the one a session already
  // holds, and its token is current (the server keeps one session per user and
  // device type, so a token from an earlier sign-in has been revoked).
  const { token } = await signIn(port, agent);
  const auth = { Authorization: `Bearer ${token}` };
  const answer = await request(port, { path: listPath, headers: auth, agent });
  agent.destroy();
  return { ms: answer.ms, answers: [answer] };
}

async function baselineAugust(port) {
  const agent = freshAgent();
  const started = Date.now();
  const { token, answer } = await signIn(port, agent, false);
  const auth = { Authorization: `Bearer ${token}` };
  const log = [answer];
  const chain = async (paths) => {
    for (const p of paths) log.push(await request(port, { path: p, headers: auth, agent, gzip: false }));
  };
  await Promise.all([...AUGUST_PROVIDERS.map(chain), chain(AUGUST_REPLICA)]);
  agent.destroy();
  return { ms: Date.now() - started, answers: log };
}

// --- running ---------------------------------------------------------------

async function measure(label, runs, once) {
  const samples = [];
  let bytes = 0;
  let requests = 0;
  let notes = {};
  for (let i = 0; i < runs; i += 1) {
    const result = await once(i);
    // A refused or failed request is not a fast one: nothing is reported for a
    // scenario whose answers include an error.
    const failed = result.answers.filter((a) => a.status >= 400);
    if (failed.length) {
      throw new Error(`${label}: ${failed.length} answers failed (${failed.map((a) => a.status).join(', ')})`);
    }
    samples.push(result.ms);
    bytes = result.answers.reduce((sum, a) => sum + a.bytes, 0);
    requests = result.answers.length;
    if (result.hydratedInTime === false) notes.lateBootstrap = (notes.lateBootstrap || 0) + 1;
    process.stdout.write(`\r  ${label}: ${i + 1}/${runs}   `);
  }
  process.stdout.write('\n');
  return {
    runs,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: Math.max(...samples),
    bytes,
    requests,
    notes,
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paper-bench-'));
  // The server reports each request's time in SQLite as Server-Timing.
  process.env.PAPER_DB_TIMING = '1';
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = EMAIL;
  process.env.PAPER_SUPER_ADMIN_PASSWORD = PASSWORD;
  const quiet = console.log;
  console.log = () => {};
  const backend = require('../../server.js');
  await backend.resetAndSeedDemoData();
  const server = http.createServer(backend.app);
  // Node's 5 s default closes an idle connection while the throttled link is
  // still carrying the close, and the next request on it hangs up. A server
  // behind nginx keeps connections far longer.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log = quiet;

  const direct = freshAgent();
  const { token } = await signIn(port, direct);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const api = (method, route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  console.log('Filling the workspace…');
  console.log = () => {};
  await fillWorkspace(api);
  console.log = quiet;

  // What a previous session's response cache would hold.
  const etags = { head: 0, byPath: {} };
  etags.head = json(await request(port, { path: '/api/changes?since=999999999', headers: auth, agent: direct })).head;
  for (const p of UNREPLICATED) {
    const answer = await request(port, { path: p, headers: auth, agent: direct });
    if (answer.headers.etag && String(answer.headers['cache-control'] || '').includes('must-revalidate')) {
      etags.byPath[p] = answer.headers.etag;
    }
  }

  // Server time: time to first byte on loopback, nothing in between.
  console.log('Server time (loopback, unthrottled)…');
  const serverTime = {};
  const dbMs = (answer) => {
    const match = /db;dur=([0-9.]+)/.exec(String(answer.headers['server-timing'] || ''));
    return match ? Number(match[1]) : NaN;
  };
  const serverReads = ['/api/items', '/api/orders', '/api/challans', '/api/inventory/overview', '/api/clients', '/api/units', '/api/changes?since=0', '/api/replica/bootstrap'];
  for (const p of serverReads) {
    const times = [];
    const db = [];
    for (let i = 0; i < RUNS; i += 1) {
      const answer = await request(port, { path: p, headers: auth, agent: direct });
      times.push(answer.firstByteMs);
      db.push(dbMs(answer));
    }
    serverTime[p] = { p50: percentile(times, 50), p99: percentile(times, 99), db99: percentile(db, 99) };
  }
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const client = await backend.get('SELECT id FROM clients ORDER BY id LIMIT 1');
  const part = await backend.saveItem({ name: 'Bench part', alias: '', displayName: 'Bench part', groupId: group.id, unitId: unit.id, variationTree: [] });
  const writes = [];
  const writesDb = [];
  for (let i = 0; i < RUNS; i += 1) {
    const answer = await request(port, {
      method: 'POST', path: '/api/orders', headers: auth, agent: direct,
      body: { orderNo: `BENCH-${i}`, clientId: client.id, itemId: part.id, variationLeafNodeId: 0, variationPathNodeIds: [], quantity: 1, status: 'notStarted' },
    });
    writes.push(answer.firstByteMs);
    writesDb.push(dbMs(answer));
  }
  serverTime['POST /api/orders (a write: the SQLite lock is held)'] = { p50: percentile(writes, 50), p99: percentile(writes, 99), db99: percentile(writesDb, 99) };

  const results = {};
  for (const profile of PROFILES) {
    console.log(`\n${profile.name}`);
    const link = async (seed) => createThrottledLink({ targetPort: port, ...profile, seed });
    const run = async (seed, fn) => {
      const l = await link(seed);
      try { return await fn(l.port); } finally { await l.close(); }
    };
    results[profile.key] = {
      sign_in_cold: await measure('sign_in_cold', RUNS, (i) => run(i + 1, signInCold)),
      sign_in_warm: await measure('sign_in_warm', RUNS, (i) => run(i + 1, (p) => signInWarm(p, etags))),
      inventory_overview: await measure('inventory_overview', RUNS, (i) => run(i + 1, (p) => oneList(p, '/api/inventory/overview'))),
      orders_list: await measure('orders_list', RUNS, (i) => run(i + 1, (p) => oneList(p, '/api/orders'))),
      items_list: await measure('items_list', RUNS, (i) => run(i + 1, (p) => oneList(p, '/api/items'))),
      baseline_august: await measure('baseline_august', BASELINE_RUNS, (i) => run(i + 1, baselineAugust)),
    };
  }
  direct.destroy();
  server.close();

  const verdicts = SLOS.map((slo) => {
    const got = results[slo.profile][slo.scenario][`p${slo.p}`];
    return { ...slo, got, pass: got < slo.limitMs };
  });
  // The SLO names the database: the time a request holds SQLite, which every
  // other request waits behind. Asserted on every read and the write, the
  // bootstrap included. Total server time (SQLite and JavaScript) is reported
  // beside it, and any request over the limit is named in the report.
  const dbPass = Object.values(serverTime).every((t) => t.db99 < SERVER_P99_LIMIT_MS);
  const serverPass = dbPass;

  const report = render({ results, verdicts, serverTime, serverPass });
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, report);
    console.log(`\nReport: ${REPORT}`);
  }
  console.log('\n' + verdicts.map((v) => `${v.pass ? 'PASS' : 'FAIL'}  ${v.scenario} p${v.p} on ${v.profile}: ${v.got.toFixed(0)} ms (< ${v.limitMs})`).join('\n'));
  console.log(`${serverPass ? 'PASS' : 'FAIL'}  SQLite time p99 < ${SERVER_P99_LIMIT_MS} ms on every read and the write`);
  const overTotal = Object.entries(serverTime).filter(([, t]) => t.p99 >= SERVER_P99_LIMIT_MS).map(([p, t]) => `${p} ${t.p99.toFixed(1)} ms`);
  if (overTotal.length) console.log(`NOTE  total server time p99 over ${SERVER_P99_LIMIT_MS} ms: ${overTotal.join('; ')}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(verdicts.every((v) => v.pass) && serverPass ? 0 : 1);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;

function render({ results, verdicts, serverTime, serverPass }) {
  const lines = [];
  const scenarios = ['sign_in_cold', 'sign_in_warm', 'inventory_overview', 'orders_list', 'items_list', 'baseline_august'];
  lines.push('# Constrained-network results — November 2026', '');
  const load = require('node:os').loadavg().map((n) => n.toFixed(1)).join(' / ');
  lines.push(`Generated by \`backend/test/benchmarks/network-throttle.js\` on ${new Date().toISOString().slice(0, 10)}; ${RUNS} runs per scenario (${BASELINE_RUNS} for the August model). Host load average at the end of the run (1 / 5 / 15 min): ${load} on ${require('node:os').cpus().length} cores — server times are the host's as much as the code's, so read them with it.`, '');
  lines.push('## SLOs', '', '| Scenario | Link | Target | Measured | |', '|---|---|---|---|---|');
  for (const v of verdicts) {
    lines.push(`| ${v.scenario} | ${PROFILES.find((p) => p.key === v.profile).name} | p${v.p} < ${fmt(v.limitMs)} | ${fmt(v.got)} | ${v.pass ? 'pass' : '**fail**'} |`);
  }
  lines.push(`| time in SQLite, every read and a write | loopback | p99 < ${SERVER_P99_LIMIT_MS} ms | see below | ${serverPass ? 'pass' : '**fail**'} |`, '');
  for (const profile of PROFILES) {
    lines.push(`## ${profile.name}`, '', '| Scenario | p50 | p95 | p99 | max | requests | bytes on the wire |', '|---|---|---|---|---|---|---|');
    for (const s of scenarios) {
      const r = results[profile.key][s];
      const late = r.notes.lateBootstrap ? ` (bootstrap over 3 s in ${r.notes.lateBootstrap} runs)` : '';
      lines.push(`| ${s}${late} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${r.requests} | ${kb(r.bytes)} |`);
    }
    lines.push('');
  }
  lines.push('## August model against today', '', '| Link | August model p95 | Today, first launch p95 | Today, relaunch p95 | Bytes then → first launch → relaunch |', '|---|---|---|---|---|');
  for (const profile of PROFILES) {
    const r = results[profile.key];
    lines.push(`| ${profile.name} | ${fmt(r.baseline_august.p95)} | ${fmt(r.sign_in_cold.p95)} | ${fmt(r.sign_in_warm.p95)} | ${kb(r.baseline_august.bytes)} → ${kb(r.sign_in_cold.bytes)} → ${kb(r.sign_in_warm.bytes)} |`);
  }
  lines.push('', 'The August figure that started this work was 235 KB of uncompressed JSON measured on a real workspace. The August model above replays the August request pattern (no gzip, chained provider calls, thirteen replica lists in sequence) against **today\'s** server on this benchmark\'s workspace, so its bytes are not that 235 KB: today\'s endpoints are already slimmer, which flatters the model.', '');
  lines.push('## Server time (loopback, no throttling)', '', '| Request | total p50 | total p99 | in SQLite, p99 |', '|---|---|---|---|');
  for (const [p, t] of Object.entries(serverTime)) {
    const over = t.p99 >= SERVER_P99_LIMIT_MS ? ' **(over 25 ms)**' : '';
    lines.push(`| \`${p}\` | ${t.p50.toFixed(1)} ms | ${t.p99.toFixed(1)} ms${over} | ${t.db99.toFixed(1)} ms |`);
  }
  lines.push('', '*Total* is time to first byte with nothing in between: SQLite and the JavaScript that builds the answer. *In SQLite* is the server\'s own `Server-Timing: db` (kernel/db-timing.js, on with `PAPER_DB_TIMING=1`): the time the request held the database, which every other request — writes included — waits behind. The SLO is asserted on that. A request whose total is over 25 ms spends the rest in JavaScript building a large answer; it occupies the CPU, not the database.', '');
  lines.push('## How the link is modelled', '');
  lines.push('A TCP proxy in front of the server (`backend/test/benchmarks/throttle-proxy.js`): one queue per direction drained at the link\'s bandwidth and shared by every connection; half the round trip each way; one round trip of handshake per new connection; slow start from a 10-segment window doubling each round trip; 2% loss modelled per 1448-byte segment as a resend one round trip later that holds up what follows it on that connection. Not modelled: the real TCP stack (the proxy speaks loopback), congestion-window collapse after loss, jitter. Each run starts on fresh connections, as a launch does; the list scenarios reuse one already open, as a refresh inside a session does. The client sends `Accept-Encoding: gzip`, as the apps do (the August model sends `identity`).');
  lines.push('', 'The workspace: the demo seed filled through the API to 300 parts, 250 order lines, 150 challans, 120 materials, 40 clients, 15 vendors, 60 dies and 25 machines (`backend/test/helpers/sized-workspace.js`).', '');
  return lines.join('\n') + '\n';
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
