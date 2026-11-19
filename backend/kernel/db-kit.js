'use strict';

// ---------------------------------------------------------------------------
// One way to write several rows as one.
//
// SQLite has no nested BEGIN, which is why the modules grew a `useTransaction`
// flag and hand-written BEGIN / COMMIT / ROLLBACK. These two helpers take the
// hand-writing away:
//
//   withTransaction(run, work)         BEGIN, work(), COMMIT; ROLLBACK and
//                                      rethrow if work throws. For a flow
//                                      that is never called from inside
//                                      another.
//   withSavepoint(run, name, work)     SAVEPOINT, work(), RELEASE; ROLLBACK TO
//                                      and rethrow if work throws. Legal
//                                      inside a transaction or another
//                                      savepoint, and on its own (then it is
//                                      the transaction).
//
// Both take `{ rollbackWhen }`: a moved handler answers a failure instead of
// throwing (`{ status: 500, body }`), and a service answers `{ refusal }`;
// the predicate says which results undo the writes. The default undoes an
// answer whose status is 400 or above and a result that carries a refusal.
// ---------------------------------------------------------------------------

let savepointSerial = 0;

const failed = (result) =>
  Boolean(result) && typeof result === 'object' && (Number(result.status) >= 400 || Boolean(result.refusal));

async function withTransaction(run, work, { rollbackWhen = failed } = {}) {
  await run('BEGIN TRANSACTION');
  let result;
  try {
    result = await work();
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    throw error;
  }
  if (rollbackWhen(result)) {
    await run('ROLLBACK').catch(() => {});
  } else {
    await run('COMMIT');
  }
  return result;
}

async function withSavepoint(run, name, work, { rollbackWhen = failed } = {}) {
  savepointSerial += 1;
  const savepoint = `sp_${String(name).replace(/[^A-Za-z0-9_]/g, '_')}_${savepointSerial}`;
  await run(`SAVEPOINT ${savepoint}`);
  let result;
  try {
    result = await work();
  } catch (error) {
    await run(`ROLLBACK TO ${savepoint}`).catch(() => {});
    await run(`RELEASE ${savepoint}`).catch(() => {});
    throw error;
  }
  if (rollbackWhen(result)) {
    await run(`ROLLBACK TO ${savepoint}`).catch(() => {});
  }
  await run(`RELEASE ${savepoint}`);
  return result;
}

module.exports = { withTransaction, withSavepoint };
