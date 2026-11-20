'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');
const { REPLICA_LISTS } = require('../modules/realtime/routes');

// GET /api/replica/bootstrap: a cold replica's thirteen lists in one answer.
//
// The replica stores each row verbatim, and the same table is later updated
// one record at a time from the record endpoints, so a bootstrap list that
// differed from its own endpoint would leave the replica holding two shapes of
// the same thing. These compare them.

async function boot() {
  const tempDir = makeTempDir('paper-replica-boot-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'bootstrap@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData('scenario_a');
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bootstrap@paper.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  const getJson = (route) => fetch(`${baseUrl}${route}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { backend, server, baseUrl, headers, getJson };
}

const firstList = (body) => (Array.isArray(body) ? body : Object.values(body).find(Array.isArray) || []);

test('every list in the bootstrap is what its own endpoint answers', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));

  const boot1 = await ctx.getJson('/api/replica/bootstrap');
  assert.equal(boot1.status, 200, JSON.stringify(boot1.body).slice(0, 300));
  assert.equal(boot1.body.success, true);
  assert.deepEqual(boot1.body.missing, [], 'every list loaded');
  assert.deepEqual(boot1.body.refused, [], 'the owner can read every list');
  assert.deepEqual(Object.keys(boot1.body.lists).sort(), Object.keys(REPLICA_LISTS).sort());

  for (const [table, listPath] of Object.entries(REPLICA_LISTS)) {
    const own = await ctx.getJson(listPath);
    assert.equal(own.status, 200, `${listPath} answers`);
    assert.deepEqual(boot1.body.lists[table], firstList(own.body), `${table} is ${listPath}, row for row`);
  }
  assert.ok(boot1.body.lists.items.length > 0 && boot1.body.lists.order_items.length > 0, 'the scenario is not empty');
});

test('the head is read before the lists, so nothing written meanwhile is lost', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));

  const before = Number((await ctx.backend.get('SELECT MAX(id) AS head FROM changelog')).head || 0);
  const answer = (await ctx.getJson('/api/replica/bootstrap')).body;
  assert.equal(answer.head, before, 'nothing was written, so the head is the head');

  // A write after the head was taken shows up in the changes from it.
  const made = await fetch(`${ctx.baseUrl}/api/vendors`, {
    method: 'POST', headers: ctx.headers, body: JSON.stringify({ name: 'After The Head' }),
  });
  assert.ok(made.status < 300);
  const changes = (await ctx.getJson(`/api/changes?since=${answer.head}`)).body.changes;
  assert.ok(changes.some((change) => change.table_name === 'vendors'), 'the replay from the head carries the write');
});

test('a bootstrap needs a session', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const anonymous = await fetch(`${ctx.baseUrl}/api/replica/bootstrap`);
  assert.equal(anonymous.status, 401);
});

test('a replica that holds only some tables is sent only those', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const answer = (await ctx.getJson('/api/replica/bootstrap?tables=items,units,nonsense')).body;
  assert.deepEqual(Object.keys(answer.lists).sort(), ['items', 'units']);
  assert.deepEqual(answer.missing, []);
});
