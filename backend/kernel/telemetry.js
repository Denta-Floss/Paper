'use strict';

// What the server is doing, for the people who keep it running.
//
//   requests   per route (the Express pattern, not the URL — /api/items/:id is
//              one row, not one per part): duration p50/p95/p99 over the last
//              RING samples, bytes in and out, status classes, and a cumulative
//              duration histogram for Prometheus.
//   sqlite     writes on either connection: how long each took from being
//              handed to the driver to its callback, how much of that SQLite
//              spent executing (the driver's `profile` event), and so how long
//              writes WAITED for the one shared connection — the in-process
//              write lock. SQLite's profile hook resolves only to the
//              millisecond, so a sub-millisecond write's execution reads as
//              short and the wait is an upper bound — exact where it matters,
//              when writes queue for milliseconds. busy_timeout sleeps for the other connection's lock
//              happen inside a statement's execution, so they are in `exec`,
//              not `wait`; SQLITE_BUSY errors that outlast it are counted.
//   checkpoint a PASSIVE wal_checkpoint every `checkpointEveryMs`, timed, with
//              the pages it found in the log and moved. SQLite's own automatic
//              checkpoints (every 1000 pages) cannot be observed from here.
//   files      paper.db, -wal and -shm sizes, read when asked.
//
// Bytes out are counted beneath compression — this middleware is mounted
// before it — so they are what went on the wire. Bytes in are the declared
// Content-Length (a chunked upload counts 0; none of the apps send one).
//
// The event stream (/api/events) is left out of the request numbers: it is one
// response that lasts as long as the client is connected.
//
// Memory is bounded: RING durations per route, routes being the app's own
// patterns plus one 'unmatched' row.

const fs = require('node:fs');

const RING = 512;
const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|CREATE|DROP|ALTER|WITH)\b/i;

/// Durations, most recent RING kept for exact percentiles over that window, all
/// of them counted into the histogram.
class Samples {
  constructor() {
    this.ring = new Float64Array(RING);
    this.filled = 0;
    this.next = 0;
    this.count = 0;
    this.sum = 0;
    this.buckets = new Array(BUCKETS_MS.length + 1).fill(0);
  }

  add(ms) {
    this.ring[this.next] = ms;
    this.next = (this.next + 1) % RING;
    if (this.filled < RING) this.filled += 1;
    this.count += 1;
    this.sum += ms;
    let i = 0;
    while (i < BUCKETS_MS.length && ms > BUCKETS_MS[i]) i += 1;
    this.buckets[i] += 1;
  }

  /// Nearest-rank percentiles over the kept window.
  percentiles() {
    if (this.filled === 0) return { p50: null, p95: null, p99: null };
    const sorted = Array.from(this.ring.subarray(0, this.filled)).sort((a, b) => a - b);
    const at = (p) => round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
    return { p50: at(50), p95: at(95), p99: at(99) };
  }

  summary() {
    return { count: this.count, window: this.filled, ...this.percentiles(), meanMs: this.count ? round(this.sum / this.count) : null };
  }
}

function round(ms) {
  return Math.round(ms * 1000) / 1000;
}

function routeKey(req) {
  if (!req.route) return 'unmatched';
  const path = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
  return `${req.method} ${req.baseUrl || ''}${path}`;
}

function createTelemetry({ now = () => process.hrtime.bigint(), checkpointEveryMs = 5 * 60 * 1000 } = {}) {
  const startedAt = new Date().toISOString();
  const routes = new Map();
  const watched = new Set();
  const sqlite = {
    writes: new Samples(),
    execMsTotal: 0,
    elapsedMsTotal: 0,
    // Elapsed time of the writes that started while SQLite's profiling was on —
    // the only ones whose execution time is known, so the only ones the wait
    // can be worked out for. The schema setup at boot runs before it is.
    profiledElapsedMsTotal: 0,
    profiledWrites: 0,
    busyErrors: 0,
    byConnection: { main: 0, delete: 0 },
  };
  const checkpoints = {
    runs: 0,
    failures: 0,
    durations: new Samples(),
    last: null,
  };
  let timer = null;

  function routeStats(key) {
    let stats = routes.get(key);
    if (!stats) {
      stats = { durations: new Samples(), bytesIn: 0, bytesOut: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
      routes.set(key, stats);
    }
    return stats;
  }

  function middleware(req, res, next) {
    const started = now();
    let bytesOut = 0;
    const write = res.write;
    const end = res.end;
    const count = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return;
      bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    };
    res.write = function countedWrite(chunk, encoding, ...rest) {
      count(chunk, encoding);
      return write.call(this, chunk, encoding, ...rest);
    };
    res.end = function countedEnd(chunk, encoding, ...rest) {
      count(chunk, encoding);
      return end.call(this, chunk, encoding, ...rest);
    };
    res.on('finish', () => {
      if (String(res.getHeader('content-type') || '').startsWith('text/event-stream')) return;
      const stats = routeStats(routeKey(req));
      stats.durations.add(Number(now() - started) / 1e6);
      stats.bytesIn += Number(req.headers['content-length']) || 0;
      stats.bytesOut += bytesOut;
      const klass = `${Math.floor(res.statusCode / 100)}xx`;
      if (klass in stats.status) stats.status[klass] += 1;
    });
    next();
  }

  /// Wraps a write's driver call the way db-timing does: `issue(done)` starts
  /// it, `done(error)` is called from its callback.
  function timedWrite(connection, sql, issue) {
    if (typeof sql !== 'string' || !WRITE_SQL.test(sql)) return issue(() => {});
    const started = now();
    const profiled = watched.size > 0;
    return issue((error) => {
      const ms = Number(now() - started) / 1e6;
      sqlite.writes.add(ms);
      sqlite.elapsedMsTotal += ms;
      if (profiled) {
        sqlite.profiledElapsedMsTotal += ms;
        sqlite.profiledWrites += 1;
      }
      sqlite.byConnection[connection] = (sqlite.byConnection[connection] || 0) + 1;
      if (error && (error.code === 'SQLITE_BUSY' || /SQLITE_BUSY/.test(String(error.message)))) sqlite.busyErrors += 1;
    });
  }

  /// The driver's `profile` event: how long SQLite itself spent on a statement.
  function onProfile(sql, ms) {
    if (typeof sql === 'string' && WRITE_SQL.test(sql) && Number.isFinite(ms)) sqlite.execMsTotal += ms;
  }

  /// Watches a sqlite3 Database's statements. Adding the listener is what turns
  /// SQLite's profiling on for that connection — and the driver delivers it
  /// through a referenced libuv handle, which keeps the process alive until the
  /// listener is removed. So the running server turns it on at boot and a test
  /// that does must turn it off again ([unwatchConnection]).
  function watchConnection(database) {
    if (watched.has(database)) return;
    watched.add(database);
    database.on('profile', onProfile);
  }

  function unwatchConnection(database) {
    if (!watched.delete(database)) return;
    database.removeListener('profile', onProfile);
  }

  async function checkpoint(get) {
    const started = now();
    try {
      const row = await get('PRAGMA wal_checkpoint(PASSIVE)');
      const ms = Number(now() - started) / 1e6;
      checkpoints.runs += 1;
      checkpoints.durations.add(ms);
      checkpoints.last = {
        at: new Date().toISOString(),
        durationMs: round(ms),
        // SQLite's three columns: whether it could not finish because of a
        // reader or writer, the pages in the log, the pages moved to the db.
        busy: Number(row?.busy ?? 0),
        logPages: Number(row?.log ?? -1),
        checkpointedPages: Number(row?.checkpointed ?? -1),
      };
      return checkpoints.last;
    } catch (error) {
      checkpoints.failures += 1;
      checkpoints.last = { at: new Date().toISOString(), error: String(error?.message || error) };
      return checkpoints.last;
    }
  }

  function startCheckpoints(get) {
    if (timer || !(checkpointEveryMs > 0)) return;
    timer = setInterval(() => { checkpoint(get); }, checkpointEveryMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function fileSizes(dbPath) {
    const size = (path) => {
      try {
        return fs.statSync(path).size;
      } catch (_) {
        return 0;
      }
    };
    if (!dbPath) return null;
    return { db: size(dbPath), wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) };
  }

  function snapshot({ dbPath } = {}) {
    const routeRows = {};
    const totals = { count: 0, bytesIn: 0, bytesOut: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } };
    const everything = new Samples();
    for (const [key, stats] of [...routes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      routeRows[key] = {
        ...stats.durations.summary(),
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        status: { ...stats.status },
      };
      totals.count += stats.durations.count;
      totals.bytesIn += stats.bytesIn;
      totals.bytesOut += stats.bytesOut;
      for (const klass of Object.keys(totals.status)) totals.status[klass] += stats.status[klass];
      for (let i = 0; i < stats.durations.filled; i += 1) everything.add(stats.durations.ring[i]);
    }
    // Without the profile hook there is no execution time to subtract, and the
    // whole elapsed time would read as waiting: say "unknown" instead.
    const profiling = watched.size > 0;
    const waitMs = profiling ? Math.max(0, sqlite.profiledElapsedMsTotal - sqlite.execMsTotal) : null;
    return {
      startedAt,
      capturedAt: new Date().toISOString(),
      requests: {
        total: { ...totals, ...everything.percentiles() },
        routes: routeRows,
      },
      sqlite: {
        writes: sqlite.writes.summary(),
        byConnection: { ...sqlite.byConnection },
        elapsedMsTotal: round(sqlite.elapsedMsTotal),
        profiling,
        execMsTotal: round(sqlite.execMsTotal),
        lockWaitMsTotal: waitMs == null ? null : round(waitMs),
        profiledWrites: sqlite.profiledWrites,
        lockWaitMsPerWrite: waitMs != null && sqlite.profiledWrites ? round(waitMs / sqlite.profiledWrites) : null,
        note: 'exec comes from SQLite\'s profile hook, in whole milliseconds; for sub-millisecond writes lockWait is an upper bound',
        busyErrors: sqlite.busyErrors,
      },
      walCheckpoint: {
        everyMs: checkpointEveryMs,
        runs: checkpoints.runs,
        failures: checkpoints.failures,
        durations: checkpoints.durations.summary(),
        last: checkpoints.last,
      },
      files: fileSizes(dbPath),
    };
  }

  /// The Prometheus text exposition format (0.0.4) of the same numbers.
  function prometheus(snap) {
    const lines = [];
    const esc = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const metric = (name, type, help) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    metric('paper_http_request_duration_ms', 'histogram', 'Request duration by route, milliseconds.');
    for (const [key, stats] of routes) {
      const label = `route="${esc(key)}"`;
      let cumulative = 0;
      BUCKETS_MS.forEach((le, i) => {
        cumulative += stats.durations.buckets[i];
        lines.push(`paper_http_request_duration_ms_bucket{${label},le="${le}"} ${cumulative}`);
      });
      cumulative += stats.durations.buckets[BUCKETS_MS.length];
      lines.push(`paper_http_request_duration_ms_bucket{${label},le="+Inf"} ${cumulative}`);
      lines.push(`paper_http_request_duration_ms_sum{${label}} ${round(stats.durations.sum)}`);
      lines.push(`paper_http_request_duration_ms_count{${label}} ${stats.durations.count}`);
    }
    metric('paper_http_requests_total', 'counter', 'Requests by route and status class.');
    for (const [key, stats] of routes) {
      for (const [klass, n] of Object.entries(stats.status)) {
        lines.push(`paper_http_requests_total{route="${esc(key)}",status="${klass}"} ${n}`);
      }
    }
    metric('paper_http_request_bytes_total', 'counter', 'Declared request body bytes by route.');
    for (const [key, stats] of routes) lines.push(`paper_http_request_bytes_total{route="${esc(key)}"} ${stats.bytesIn}`);
    metric('paper_http_response_bytes_total', 'counter', 'Response bytes on the wire (after compression) by route.');
    for (const [key, stats] of routes) lines.push(`paper_http_response_bytes_total{route="${esc(key)}"} ${stats.bytesOut}`);

    metric('paper_sqlite_writes_total', 'counter', 'Write statements, both connections.');
    lines.push(`paper_sqlite_writes_total ${snap.sqlite.writes.count}`);
    metric('paper_sqlite_write_elapsed_ms_total', 'counter', 'Write time from hand-off to callback.');
    lines.push(`paper_sqlite_write_elapsed_ms_total ${snap.sqlite.elapsedMsTotal}`);
    metric('paper_sqlite_write_exec_ms_total', 'counter', 'Write time SQLite spent executing (includes busy_timeout waits).');
    lines.push(`paper_sqlite_write_exec_ms_total ${snap.sqlite.execMsTotal}`);
    if (snap.sqlite.lockWaitMsTotal != null) {
      metric('paper_sqlite_write_lock_wait_ms_total', 'counter', 'Write time spent waiting for the shared connection.');
      lines.push(`paper_sqlite_write_lock_wait_ms_total ${snap.sqlite.lockWaitMsTotal}`);
    }
    metric('paper_sqlite_busy_errors_total', 'counter', 'Writes that failed with SQLITE_BUSY.');
    lines.push(`paper_sqlite_busy_errors_total ${snap.sqlite.busyErrors}`);

    metric('paper_wal_checkpoints_total', 'counter', 'PASSIVE checkpoints run by the server.');
    lines.push(`paper_wal_checkpoints_total ${snap.walCheckpoint.runs}`);
    metric('paper_wal_checkpoint_duration_ms_sum', 'counter', 'Total checkpoint time.');
    lines.push(`paper_wal_checkpoint_duration_ms_sum ${round(checkpoints.durations.sum)}`);
    if (snap.walCheckpoint.last && snap.walCheckpoint.last.error == null) {
      metric('paper_wal_checkpoint_last_pages', 'gauge', 'Pages in the log and moved, last checkpoint.');
      lines.push(`paper_wal_checkpoint_last_pages{kind="log"} ${snap.walCheckpoint.last.logPages}`);
      lines.push(`paper_wal_checkpoint_last_pages{kind="checkpointed"} ${snap.walCheckpoint.last.checkpointedPages}`);
    }
    if (snap.files) {
      metric('paper_db_file_bytes', 'gauge', 'Database file sizes.');
      for (const [file, bytes] of Object.entries(snap.files)) lines.push(`paper_db_file_bytes{file="${file}"} ${bytes}`);
    }
    return `${lines.join('\n')}\n`;
  }

  return { middleware, timedWrite, watchConnection, unwatchConnection, onProfile, checkpoint, startCheckpoints, stop, snapshot, prometheus };
}

module.exports = { createTelemetry, routeKey, BUCKETS_MS, RING };
