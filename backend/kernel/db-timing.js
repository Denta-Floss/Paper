'use strict';

// How long a request spent in SQLite, reported as `Server-Timing: db;dur=…`.
//
// Off unless PAPER_DB_TIMING=1. The constrained-network benchmark turns it on
// to separate the time a request holds the database — which every other
// request, writes included, waits behind — from the time it spends in
// JavaScript building its answer. The two are one number from outside.
//
// Measured from the statement being handed to the driver to its callback, so
// it includes any wait behind another request's statements: that is the
// database as this request experienced it.

const { AsyncLocalStorage } = require('node:async_hooks');

const enabled = process.env.PAPER_DB_TIMING === '1';
const store = new AsyncLocalStorage();

/// Wraps a driver call. `issue(done)` starts the statement and calls `done`
/// when it finishes; the elapsed time is added to the request's total.
///
/// The union of the request's statements, not their sum: a request that runs
/// four reads at once holds the database for as long as any of them is
/// outstanding, and adding their times would count the overlap four times.
function timed(issue) {
  const totals = enabled ? store.getStore() : null;
  if (!totals) return issue(() => {});
  totals.statements += 1;
  if (totals.outstanding === 0) totals.since = process.hrtime.bigint();
  totals.outstanding += 1;
  return issue(() => {
    totals.outstanding -= 1;
    if (totals.outstanding === 0) totals.ms += Number(process.hrtime.bigint() - totals.since) / 1e6;
  });
}

function middleware(req, res, next) {
  if (!enabled) return next();
  const totals = { ms: 0, statements: 0, outstanding: 0, since: 0n };
  const writeHead = res.writeHead;
  res.writeHead = function withTiming(...args) {
    if (!res.headersSent) {
      res.setHeader('Server-Timing', `db;dur=${totals.ms.toFixed(2)};desc="${totals.statements} statements"`);
    }
    return writeHead.apply(this, args);
  };
  return store.run(totals, next);
}

module.exports = { timed, middleware, enabled };
