const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');

const { withTransaction, withSavepoint } = require('../kernel/db-kit');

// The two ways several rows are written as one. SQLite has no nested BEGIN;
// a savepoint nests, and on its own it is the transaction.

function memoryDb() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(error) {
        if (error) reject(error);
        else resolve({ changes: this.changes });
      });
    });
  const count = () =>
    new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS n FROM t', (error, row) => (error ? reject(error) : resolve(row.n))));
  return { run, count, ready: run('CREATE TABLE t (v TEXT)') };
}

test('a transaction commits what succeeded and undoes what threw', async () => {
  const { run, count, ready } = memoryDb();
  await ready;
  assert.equal(await withTransaction(run, async () => { await run("INSERT INTO t VALUES ('a')"); return 'done'; }), 'done');
  assert.equal(await count(), 1);
  await assert.rejects(withTransaction(run, async () => { await run("INSERT INTO t VALUES ('b')"); throw new Error('no'); }), /no/);
  assert.equal(await count(), 1, 'the row written before the throw is gone');
});

test('a transaction also undoes a failure that is answered rather than thrown', async () => {
  const { run, count, ready } = memoryDb();
  await ready;
  const answer = await withTransaction(run, async () => { await run("INSERT INTO t VALUES ('a')"); return { status: 500, body: {} }; });
  assert.equal(answer.status, 500);
  assert.equal(await count(), 0, 'a 500 answer is a failure');
  const refused = await withTransaction(run, async () => { await run("INSERT INTO t VALUES ('a')"); return { refusal: { status: 404 } }; });
  assert.ok(refused.refusal);
  assert.equal(await count(), 0, 'a refusal is a failure');
  const ok = await withTransaction(run, async () => { await run("INSERT INTO t VALUES ('a')"); return { status: 201, body: {} }; });
  assert.equal(ok.status, 201);
  assert.equal(await count(), 1);
});

test('a savepoint on its own is a transaction', async () => {
  const { run, count, ready } = memoryDb();
  await ready;
  await withSavepoint(run, 'one', async () => { await run("INSERT INTO t VALUES ('a')"); });
  await assert.rejects(withSavepoint(run, 'two', async () => { await run("INSERT INTO t VALUES ('b')"); throw new Error('no'); }));
  assert.equal(await count(), 1);
  // And the connection is usable afterwards: nothing is left open.
  await run("INSERT INTO t VALUES ('c')");
  assert.equal(await count(), 2);
});

test('a savepoint nests: an inner failure undoes only the inner writes', async () => {
  const { run, count, ready } = memoryDb();
  await ready;
  await withTransaction(run, async () => {
    await run("INSERT INTO t VALUES ('outer')");
    await assert.rejects(withSavepoint(run, 'inner', async () => {
      await run("INSERT INTO t VALUES ('inner')");
      throw new Error('inner failed');
    }));
    await withSavepoint(run, 'inner-again', async () => { await run("INSERT INTO t VALUES ('inner 2')"); });
  });
  assert.equal(await count(), 2, 'the outer write and the second inner one');
  // A savepoint inside a savepoint, the same way.
  await withSavepoint(run, 'a', async () => {
    await withSavepoint(run, 'b', async () => { await run("INSERT INTO t VALUES ('b')"); });
    const answered = await withSavepoint(run, 'c', async () => { await run("INSERT INTO t VALUES ('c')"); return { status: 400 }; });
    assert.equal(answered.status, 400);
  });
  assert.equal(await count(), 3);
});

test('a savepoint name is made safe for SQL', async () => {
  const { run, count, ready } = memoryDb();
  await ready;
  await withSavepoint(run, 'odd name; DROP', async () => { await run("INSERT INTO t VALUES ('x')"); });
  assert.equal(await count(), 1);
});
