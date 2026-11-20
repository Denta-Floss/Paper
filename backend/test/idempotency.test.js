'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { makeTempDir } = require('./helpers/temp-dir');
const { createIdempotency, current } = require('../kernel/idempotency');

// Retried writes apply once (kernel/idempotency.js).
//
// A phone sends a write, the answer is lost, the phone sends it again. Each of
// the three writes the offline outbox will carry — an order, a challan, a stock
// movement — is sent twice with one key and must land once, the second answer
// being the first one replayed.

async function boot() {
  const tempDir = makeTempDir('paper-idempotency-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'idem@paper.test';
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
    body: JSON.stringify({ email: 'idem@paper.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const send = async (method, route, body, key) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`,
        ...(key ? { 'X-Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      replayed: response.headers.get('idempotent-replayed') === 'true',
      text: await response.text(),
    };
  };
  const count = async (sql, params = []) => Number((await backend.get(sql, params)).n);
  return { backend, server, send, count };
}

async function orderInput(backend, orderNo) {
  const client = await backend.get('SELECT id FROM clients WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await backend.saveItem({
    name: `Idempotent part ${orderNo}`, alias: '', displayName: `Idempotent part ${orderNo}`,
    groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return {
    item,
    body: {
      orderNo, clientId: client.id, itemId: item.id, variationLeafNodeId: 0,
      variationPathNodeIds: [], quantity: 5, status: 'notStarted',
    },
  };
}

test('an order sent twice with one key is made once, and the retry gets the same answer', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item, body } = await orderInput(ctx.backend, 'IDEM-ORD-1');

  const first = await ctx.send('POST', '/api/orders', body, 'op-order-0001');
  assert.equal(first.status, 201, first.text);
  const retry = await ctx.send('POST', '/api/orders', body, 'op-order-0001');

  assert.equal(retry.status, 201);
  assert.equal(retry.replayed, true, 'the retry is answered from the log');
  assert.equal(retry.text, first.text, 'byte for byte the first answer');
  assert.equal(await ctx.count('SELECT COUNT(*) AS n FROM order_items WHERE item_id = ?', [item.id]), 1);
  // Without the key, merging is what the endpoint does with a repeated line —
  // the quantity would have doubled. It did not.
  assert.equal(await ctx.count('SELECT SUM(quantity) AS n FROM order_items WHERE item_id = ?', [item.id]), 5);
});

test('a challan sent twice with one key is made once', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item } = await orderInput(ctx.backend, 'IDEM-CH');
  const body = {
    type: 'delivery', challanNo: 'IDEM-CH-1', date: '2026-11-20', status: 'draft',
    customerName: 'Walk-in Customer', maintainStocks: false,
    items: [{ itemId: item.id, variationLeafNodeId: 0, particulars: 'x', quantityPcs: '2', weight: '1', lineNo: 1 }],
  };
  const first = await ctx.send('POST', '/api/challans', body, 'op-challan-0001');
  assert.equal(first.status, 201, first.text);
  const retry = await ctx.send('POST', '/api/challans', body, 'op-challan-0001');
  assert.equal(retry.replayed, true);
  assert.equal(retry.text, first.text);
  assert.equal(await ctx.count("SELECT COUNT(*) AS n FROM delivery_challans WHERE challan_no = 'IDEM-CH-1'"), 1);
});

test('a stock movement sent twice with one key moves the stock once', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const material = await ctx.backend.get('SELECT barcode, on_hand_qty FROM materials ORDER BY id LIMIT 1');
  const body = {
    barcode: material.barcode, movementType: 'receive', qty: 7,
    referenceType: 'manual', referenceId: 'IDEM-MOVE-1',
  };
  const movesBefore = await ctx.count('SELECT COUNT(*) AS n FROM inventory_movements');
  const first = await ctx.send('POST', '/api/inventory/movements', body, 'op-move-0001');
  assert.ok(first.status < 300, first.text);
  const retry = await ctx.send('POST', '/api/inventory/movements', body, 'op-move-0001');
  assert.equal(retry.replayed, true);

  assert.equal(await ctx.count('SELECT COUNT(*) AS n FROM inventory_movements'), movesBefore + 1);
  const after = await ctx.backend.get('SELECT on_hand_qty FROM materials WHERE barcode = ?', [material.barcode]);
  assert.equal(Number(after.on_hand_qty), Number(material.on_hand_qty || 0) + 7, 'seven received, not fourteen');
});

test('five sends of one key at once still land once', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item, body } = await orderInput(ctx.backend, 'IDEM-RACE');
  const answers = await Promise.all(
    Array.from({ length: 5 }, () => ctx.send('POST', '/api/orders', body, 'op-race-00001')),
  );
  assert.equal(await ctx.count('SELECT COUNT(*) AS n FROM order_items WHERE item_id = ?', [item.id]), 1);
  assert.equal(await ctx.count('SELECT SUM(quantity) AS n FROM order_items WHERE item_id = ?', [item.id]), 5);
  assert.ok(answers.every((a) => a.status === 201 || a.status === 409),
    `each is the answer or "still in progress": ${answers.map((a) => a.status)}`);
  assert.equal(answers.filter((a) => a.status === 201 && !a.replayed).length, 1, 'one of them did the work');
});

test('one key for two different requests is refused, not guessed at', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { body } = await orderInput(ctx.backend, 'IDEM-REUSE');
  await ctx.send('POST', '/api/orders', body, 'op-reuse-0001');
  const other = await ctx.send('POST', '/api/orders', { ...body, quantity: 9 }, 'op-reuse-0001');
  assert.equal(other.status, 422);
  assert.equal(JSON.parse(other.text).code, 'idempotency_key_reused');
});

test('a refusal is replayed as the same refusal, and writes nothing', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const bad = { orderNo: 'IDEM-BAD', quantity: 3 }; // no client, no item
  const first = await ctx.send('POST', '/api/orders', bad, 'op-bad-000001');
  assert.ok(first.status >= 400 && first.status < 500, first.text);
  const retry = await ctx.send('POST', '/api/orders', bad, 'op-bad-000001');
  assert.equal(retry.status, first.status);
  assert.equal(retry.replayed, true);
  assert.equal(await ctx.count("SELECT COUNT(*) AS n FROM order_items WHERE order_no = 'IDEM-BAD'"), 0);
});

test('without a key nothing changes: two sends are two operations', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item, body } = await orderInput(ctx.backend, 'IDEM-NOKEY');
  await ctx.send('POST', '/api/orders', body);
  await ctx.send('POST', '/api/orders', body);
  // The orders endpoint merges a repeated line: two operations, ten pieces.
  assert.equal(await ctx.count('SELECT SUM(quantity) AS n FROM order_items WHERE item_id = ?', [item.id]), 10);
});

test('a malformed key is refused before anything runs', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item, body } = await orderInput(ctx.backend, 'IDEM-MALFORMED');
  const answer = await ctx.send('POST', '/api/orders', body, 'no spaces allowed');
  assert.equal(answer.status, 400);
  assert.equal(await ctx.count('SELECT COUNT(*) AS n FROM order_items WHERE item_id = ?', [item.id]), 0);
});

test('applied but its answer never kept: a retry is told so, and nothing runs again', async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const { item, body } = await orderInput(ctx.backend, 'IDEM-CRASH');
  await ctx.send('POST', '/api/orders', body, 'op-crash-00001');
  // As the server would leave it had it stopped after the commit and before
  // keeping the answer.
  await ctx.backend.run(
    "UPDATE idempotency_log SET state = 'committed', response_body = NULL, response_status = NULL WHERE idempotency_key = 'op-crash-00001'",
  );
  const retry = await ctx.send('POST', '/api/orders', body, 'op-crash-00001');
  assert.equal(retry.status, 409);
  assert.equal(JSON.parse(retry.text).code, 'idempotency_already_applied');
  assert.equal(await ctx.count('SELECT SUM(quantity) AS n FROM order_items WHERE item_id = ?', [item.id]), 5);
});

test('cut off mid-flight by a stop: the next boot calls it unknown and refuses to guess', async () => {
  const dir = makeTempDir('paper-idempotency-unit-');
  const db = new sqlite3.Database(path.join(dir, 'u.db'));
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function done(error) { return error ? reject(error) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))));
  const idem = createIdempotency({ run, get });
  await idem.ensureSchema();
  const now = new Date().toISOString();
  await run(`INSERT INTO idempotency_log (user_id, idempotency_key, request_hash, method, path, state, created_at)
             VALUES (1, 'op-cut-000001', 'h', 'POST', '/api/orders', 'in_flight', ?)`, [now]);
  await idem.recover();
  assert.equal((await get("SELECT state FROM idempotency_log WHERE idempotency_key = 'op-cut-000001'")).state, 'unknown');
  await new Promise((resolve) => db.close(resolve));
});

test('the mark is written inside the write\'s own transaction: rolled back together, committed together', async () => {
  const dir = makeTempDir('paper-idempotency-unit-');
  const db = new sqlite3.Database(path.join(dir, 'u.db'));
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function done(error) { return error ? reject(error) : resolve(this); }));
  const get = (sql, params = []) => new Promise((resolve, reject) =>
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row))));
  const idem = createIdempotency({ run, get });
  await idem.ensureSchema();
  await run('CREATE TABLE orders_t (id INTEGER PRIMARY KEY, n INTEGER)');
  const now = new Date().toISOString();
  const op = (key) => ({ userId: 1, key, hash: 'h', method: 'POST', path: '/x', createdAt: now, committed: false });
  const state = async (key) => (await get('SELECT state FROM idempotency_log WHERE idempotency_key = ?', [key]))?.state;

  for (const key of ['op-rollback-1', 'op-commit-01']) {
    await run(`INSERT INTO idempotency_log (user_id, idempotency_key, request_hash, method, path, state, created_at)
               VALUES (1, ?, 'h', 'POST', '/x', 'in_flight', ?)`, [key, now]);
  }

  // A write that rolls back takes its mark with it.
  await current.run(op('op-rollback-1'), async () => {
    await run('BEGIN TRANSACTION');
    await run('INSERT INTO orders_t (n) VALUES (1)');
    await idem.beforeCommit();
    await run('ROLLBACK');
  });
  assert.equal(await state('op-rollback-1'), 'in_flight', 'no mark without the write');
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM orders_t')).n), 0);

  // A write that commits carries its mark.
  await current.run(op('op-commit-01'), async () => {
    await run('BEGIN TRANSACTION');
    await run('INSERT INTO orders_t (n) VALUES (2)');
    await idem.beforeCommit();
    await run('COMMIT');
  });
  assert.equal(await state('op-commit-01'), 'committed');
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM orders_t')).n), 1);

  // And a row lost to someone else's rollback is put back, not skipped.
  await run("DELETE FROM idempotency_log WHERE idempotency_key = 'op-commit-01'");
  await current.run(op('op-lost-0001'), async () => {
    await run('BEGIN TRANSACTION');
    await idem.beforeCommit();
    await run('COMMIT');
  });
  assert.equal(await state('op-lost-0001'), 'committed');
  await new Promise((resolve) => db.close(resolve));
});

test("the order endpoint's own COMMIT carries the key (the hook is wired, not just written)", async (t) => {
  const ctx = await boot();
  t.after(() => new Promise((resolve) => ctx.server.close(resolve)));
  const seen = [];
  const original = ctx.backend.idempotency.beforeCommit;
  ctx.backend.idempotency.beforeCommit = async function traced() {
    const op = current.getStore();
    if (op) seen.push(op.key);
    return original.call(this);
  };
  t.after(() => { ctx.backend.idempotency.beforeCommit = original; });

  const { body } = await orderInput(ctx.backend, 'IDEM-WIRED');
  const answer = await ctx.send('POST', '/api/orders', body, 'op-wired-00001');
  assert.equal(answer.status, 201, answer.text);
  assert.ok(seen.includes('op-wired-00001'), `the order's transaction committed through the hook: ${seen}`);
});
