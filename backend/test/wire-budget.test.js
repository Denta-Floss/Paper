'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');
const { fillWorkspace, SIZES } = require('./helpers/sized-workspace');

// What each thing the app does costs on the wire, asserted.
//
// wire-weight.test.js records the numbers in comments and asserts shapes.
// This one asserts the numbers: a named sequence of requests — the exact
// URLs the desktop app fires, in the order it fires them — against a budget
// of requests and compressed bytes, on a workspace big enough for the bytes
// to mean something (test/helpers/sized-workspace.js). The server answers
// in milliseconds; the wire is the only cost, and a 1 Mbps line moves about
// 120 KB a second.
//
// Each budget was set from the figure measured when it was written, and the
// comment beside it says what that figure was, so a later tightening can
// quote before and after. `UPDATE_WIRE_BUDGETS=1 npm test` prints the
// current figures instead of asserting them.

const KB = 1024;

// Sequence                 budget                       measured 2026-11-19 (sized workspace)
const BUDGETS = {
  sign_in: { requests: 20, bytes: 120 * KB }, // 21 requests, 57.3 KB; 18 requests after step 3
  orders_list_page: { requests: 1, bytes: 40 * KB }, // 1 request, 7.8 KB
  items_list_page: { requests: 1, bytes: 60 * KB }, // 1 request, 26.7 KB; 20.9 KB after step 4
  inventory_overview: { requests: 1, bytes: 40 * KB }, // 4 requests, 8.9 KB; 1 request after step 3
  replica_hydration: { requests: 3, bytes: 160 * KB }, // 14 requests, 60.6 KB; 1 request after step 5
};

// What the desktop does after a sign-in, cold (the replica not hydrated), in
// the order lib/main.dart's Future.wait starts the providers. Traced through
// each provider to its repository on 2026-11-19; a provider that chains its
// calls is listed in that order.
const SIGN_IN = [
  '/api/orders',
  '/api/inventory/overview',
  '/api/units', '/api/units/gauge-table',
  '/api/groups',
  '/api/clients',
  '/api/vendors',
  '/api/items',
  '/api/company-profile', '/api/challans',
  '/api/machines',
  '/api/dies',
  '/api/departments', '/api/employees',
  '/api/freelancer-jobs',
  '/api/action-center/issues', '/api/trash',
  // AutoUpdaterService asks the server about the desktop build (Windows only).
  '/api/app/latest',
];

// A cold replica (ReplicaCatchUp): one bootstrap carrying all thirteen lists
// and the head. It used to be the thirteen lists of ReplicaApi.listPaths one
// after another, then a delta poll from 0.
const REPLICA_HYDRATION = ['/api/replica/bootstrap'];

const SEQUENCES = {
  sign_in: SIGN_IN,
  orders_list_page: ['/api/orders'],
  items_list_page: ['/api/items'],
  inventory_overview: ['/api/inventory/overview'],
  replica_hydration: REPLICA_HYDRATION,
};

// Pending until the step that lands them; asserted from then on. A budget
// here is still printed, so the figure is visible before the step.
const PENDING = {};

// A plain request, as in wire-weight.test.js: `fetch` would decompress the
// body before it could be measured, and the compressed size is the one that
// travels.
function rawGet(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { ...headers, 'Accept-Encoding': 'gzip' } },
      (response) => {
        let bytes = 0;
        response.on('data', (chunk) => { bytes += chunk.length; });
        response.on('end', () => resolve({
          status: response.statusCode,
          bytes,
          encoding: response.headers['content-encoding'] || 'identity',
        }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function record(ctx, urls) {
  const rows = [];
  for (const url of urls) {
    const answer = await rawGet(ctx.port, url, ctx.headers);
    rows.push({ url, ...answer });
  }
  return {
    rows,
    requests: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

function breakdown(name, result) {
  const lines = result.rows
    .sort((a, b) => b.bytes - a.bytes)
    .map((row) => `  ${String(row.bytes).padStart(8)} B  ${row.status}  ${row.encoding.padEnd(8)} ${row.url}`);
  return [`${name}: ${result.requests} requests, ${(result.bytes / KB).toFixed(1)} KB compressed`, ...lines].join('\n');
}

describe('wire budgets', () => {
  const ctx = {};

  before(async () => {
    const tempDir = makeTempDir('paper-wire-budget-');
    process.env.DB_PATH = path.join(tempDir, 'paper.db');
    process.env.PAPER_SUPER_ADMIN_EMAIL = 'budget@paper.test';
    process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
    delete require.cache[require.resolve('../server.js')];
    const backend = require('../server.js');
    await backend.resetAndSeedDemoData();
    const server = http.createServer(backend.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'budget@paper.test', password: 'OwnerPass1234' }),
    }).then((r) => r.json());
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
    const api = (method, route, body) =>
      fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const filled = await fillWorkspace(api);
    assert.equal(filled.items.length, SIZES.items, 'the workspace is the size the budgets were measured on');
    Object.assign(ctx, { backend, server, port, headers });
  });

  after(() => new Promise((resolve) => ctx.server.close(resolve)));

  for (const [name, urls] of Object.entries(SEQUENCES)) {
    test(name, async () => {
      const budget = BUDGETS[name];
      const result = await record(ctx, urls);
      const failed = result.rows.filter((row) => row.status >= 400);
      assert.deepEqual(failed, [], `every request in ${name} answers`);

      if (process.env.UPDATE_WIRE_BUDGETS === '1') {
        console.log(breakdown(name, result));
        return;
      }
      const over = result.requests > budget.requests || result.bytes > budget.bytes;
      if (PENDING[name]) {
        // Expected over until its step lands; expected within afterwards, at
        // which point the entry leaves PENDING and this turns into an assert.
        assert.ok(over, `${name} is within budget already — remove it from PENDING (${PENDING[name]})`);
        return;
      }
      assert.ok(
        !over,
        `${name} is over budget (${budget.requests} requests, ${budget.bytes / KB} KB)\n${breakdown(name, result)}`,
      );
    });
  }
});
