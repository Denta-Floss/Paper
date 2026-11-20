'use strict';

// Retried writes never apply twice.
//
// A phone on a factory link sends a write, the answer is lost on the way back,
// and the phone sends it again. Without this the server cannot tell the second
// send from a new order, so the order — or the challan, or the stock move — is
// made twice. A client that wants a write to be applied at most once sends
// `X-Idempotency-Key: <its own id for the operation>` (an outbox entry's UUID).
// Within a day and for the same signed-in user:
//
//   first time          the write runs; its answer is kept
//   same key again      the kept answer is replayed (`Idempotent-Replayed: true`),
//                       the write does not run again
//   same key, different request
//                       422 idempotency_key_reused — a client bug, never guessed at
//   same key while the first is still running
//                       409 idempotency_in_progress, Retry-After: 1
//   same key, applied but its answer never kept (the server stopped in between)
//                       409 idempotency_already_applied — applied once, and that
//                       is what the client needs to know
//
// THE PART THAT MAKES IT HOLD. Recording the key after the write commits leaves
// a window: the server stops between the two, the retry finds no key, and the
// write runs twice. So the mark is written INSIDE the write's own transaction:
// the server's `run` asks `beforeCommit()` on every COMMIT, and when the request
// committing carries a key, its row moves to `committed` in that same
// transaction. The write and the mark land together or not at all — for all 61
// places that open a transaction, without any of them knowing.
//
// The residue, stated: a handler that writes without opening a transaction (one
// autocommitted statement) is marked just after its write rather than with it.
// A row a stop leaves `in_flight` is read at the next boot as `unknown`, and a
// retry is refused (409 idempotency_outcome_unknown) rather than risked: a
// duplicate is the failure this exists to prevent, and a refusal can be looked
// into.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const HEADER = 'x-idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idempotency_log (
    user_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_flight', 'committed', 'done', 'unknown')),
    response_status INTEGER,
    response_type TEXT,
    response_body TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (user_id, idempotency_key)
  )
`;

/// The request's operation, readable from anywhere its handler's code runs.
const current = new AsyncLocalStorage();

// Keys sorted, so the same body sent twice hashes the same whatever order a
// client serialised it in.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function requestHash(req) {
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${req.originalUrl}\n${stable(req.body ?? null)}`)
    .digest('hex');
}

function createIdempotency({ run, get }) {
  async function ensureSchema() {
    await run(SCHEMA);
    await run('CREATE INDEX IF NOT EXISTS idx_idempotency_log_created ON idempotency_log(created_at)');
  }

  /// At boot: an operation still `in_flight` was cut off by the stop, and
  /// whether its write landed cannot be known here. Old rows go.
  async function recover() {
    await run("UPDATE idempotency_log SET state = 'unknown' WHERE state = 'in_flight'");
    await prune();
  }

  async function prune() {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    await run('DELETE FROM idempotency_log WHERE created_at < ?', [cutoff]);
  }

  /// Called by the server's `run` before every COMMIT. Inside the transaction
  /// being committed, so the mark and the write are one.
  ///
  /// An upsert, not an update. All requests share one SQLite connection, so
  /// the in-flight row can have been written inside another request's
  /// transaction and gone with its rollback; a plain update would then mark
  /// nothing, and a retry would run the write again.
  async function beforeCommit() {
    const op = current.getStore();
    if (!op || op.committed) return;
    op.committed = true;
    await run(
      `INSERT INTO idempotency_log (user_id, idempotency_key, request_hash, method, path, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'committed', ?)
       ON CONFLICT(user_id, idempotency_key) DO UPDATE SET state = 'committed'
       WHERE idempotency_log.state = 'in_flight'`,
      [op.userId, op.key, op.hash, op.method, op.path, op.createdAt],
    );
  }

  function refuse(res, status, code, error, headers = {}) {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json({ success: false, code, error });
  }

  async function middleware(req, res, next) {
    const key = req.get(HEADER);
    if (!key || !MUTATIONS.has(req.method)) return next();
    if (!KEY_PATTERN.test(key)) {
      return refuse(res, 400, 'idempotency_key_invalid',
        'X-Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores.');
    }
    const userId = req.user?.id;
    if (!userId) return next();

    try {
      const hash = requestHash(req);
      const now = new Date().toISOString();
      const inserted = await run(
        `INSERT INTO idempotency_log (user_id, idempotency_key, request_hash, method, path, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'in_flight', ?)
         ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
        [userId, key, hash, req.method, req.originalUrl, now],
      );

      if (!inserted || inserted.changes !== 1) {
        const seen = await get(
          'SELECT * FROM idempotency_log WHERE user_id = ? AND idempotency_key = ?',
          [userId, key],
        );
        if (!seen) return refuse(res, 409, 'idempotency_in_progress', 'Try again in a moment.', { 'Retry-After': '1' });
        if (seen.request_hash !== hash) {
          return refuse(res, 422, 'idempotency_key_reused',
            'This idempotency key was already used for a different request.');
        }
        if (seen.state === 'done') {
          res.setHeader('Idempotent-Replayed', 'true');
          if (seen.response_type) res.setHeader('Content-Type', seen.response_type);
          return res.status(seen.response_status || 200).send(seen.response_body ?? '');
        }
        if (seen.state === 'in_flight') {
          return refuse(res, 409, 'idempotency_in_progress',
            'This operation is still being applied. Try again in a moment.', { 'Retry-After': '1' });
        }
        if (seen.state === 'committed') {
          return refuse(res, 409, 'idempotency_already_applied',
            'This operation was applied once; its answer was not kept. Reload to see it.');
        }
        return refuse(res, 409, 'idempotency_outcome_unknown',
          'The server stopped while applying this operation, so whether it landed is not known. Check before trying again.');
      }

      const op = {
        userId, key, hash, method: req.method, path: req.originalUrl, createdAt: now, committed: false,
      };
      let body;
      const send = res.send;
      res.send = function captureSend(payload) {
        body = payload;
        return send.call(this, payload);
      };
      res.on('finish', () => {
        const status = res.statusCode;
        // A server failure that committed nothing may be retried; anything
        // else — a success, or a refusal that will refuse the same way — is
        // the answer to keep.
        const forget = status >= 500 && !op.committed;
        const write = forget
          ? run('DELETE FROM idempotency_log WHERE user_id = ? AND idempotency_key = ?', [userId, key])
          // Upserted for the same reason as beforeCommit: the row may have been
          // lost to another request's rollback.
          : run(
            `INSERT INTO idempotency_log (user_id, idempotency_key, request_hash, method, path, state,
                                          response_status, response_type, response_body, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, idempotency_key) DO UPDATE SET
               state = 'done', response_status = excluded.response_status,
               response_type = excluded.response_type, response_body = excluded.response_body,
               completed_at = excluded.completed_at`,
            [
              userId, key, hash, req.method, req.originalUrl,
              status,
              String(res.getHeader('Content-Type') || ''),
              body == null ? null : Buffer.isBuffer(body) ? body.toString('utf8') : String(body),
              now,
              new Date().toISOString(),
            ],
          );
        write.catch((error) => console.error('[Idempotency] could not record an outcome:', error.message));
      });
      return current.run(op, next);
    } catch (error) {
      return next(error);
    }
  }

  return { ensureSchema, recover, prune, beforeCommit, middleware };
}

module.exports = { createIdempotency, requestHash, HEADER, SCHEMA, current };
