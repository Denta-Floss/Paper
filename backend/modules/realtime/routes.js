'use strict';

// ---------------------------------------------------------------------------
// Realtime: how a client hears that something changed. The change log a
// replica catches up from, and the event stream it stays connected to.
//
//   GET    /api/changes
//   GET    /api/replica/bootstrap
//   GET    /api/events
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
// What a replica holds and where each list lives: the same table, the same
// path, as ReplicaApi.listPaths on the client
// (packages/core_erp/lib/core/sync/replica_api.dart). A table added there
// belongs here too, or a cold replica comes up without it.
const REPLICA_LISTS = Object.freeze({
  items: '/api/items',
  delivery_challans: '/api/challans',
  order_items: '/api/orders',
  materials: '/api/materials',
  clients: '/api/clients',
  vendors: '/api/vendors',
  machines: '/api/machines',
  dies: '/api/dies',
  units: '/api/units',
  groups: '/api/groups',
  departments: '/api/departments',
  pipeline_templates: '/api/production/pipeline-templates',
  pipeline_runs: '/runs',
});

// The list out of a list endpoint's envelope. They are not consistent —
// {items}, {data}, {orders}, {challans}, a bare array — so this takes the first
// array in the body, which is what the client's ReplicaApi.unwrapList does.
function firstList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

// These are registered ahead of the login gate: they answer without a session.
function registerRealtimeRoutesBeforeLogin(app, {
  all,
  changeEmitter,
  get,
  requireAuth,
}) {
  // ---------------------------------------------------------
  // Railway Track Real-time Events (SSE)
  // ---------------------------------------------------------
  // Any authenticated user may receive the realtime change stream. It carries only
  // {table_name, record_id, event_type} (ids, no row data); the actual fetch each
  // event triggers is separately permission-checked. Gating this behind
  // config.read wrongly starved non-admin users of live updates.
  /// The changelog from a position, as one plain response.
  ///
  /// The SSE stream replays too, but a client catching up at launch wants a
  /// request that ends — not a connection it has to hold open and decide when to
  /// stop reading. This is the endpoint a local replica calls first.
  ///
  /// `oldestAvailable` is the part that matters. The changelog is pruned, so a
  /// client that has been closed long enough can hold a cursor pointing at
  /// history that no longer exists. Replaying from the oldest surviving row would
  /// silently skip everything in between; saying what the floor is lets the
  /// client notice and take a fresh snapshot instead.
  app.get('/api/changes', requireAuth, async (req, res) => {
    try {
      const since = Math.max(0, Number(req.query.since) || 0);
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 1000));
      const rows = await all(
        `SELECT id, table_name, record_id, event_type
         FROM changelog WHERE id > ? ORDER BY id ASC LIMIT ?`,
        [since, limit + 1],
      );
      const hasMore = rows.length > limit;
      const changes = hasMore ? rows.slice(0, limit) : rows;
      const floor = await get('SELECT MIN(id) AS oldest, MAX(id) AS head FROM changelog');
      res.json({
        success: true,
        changes,
        hasMore,
        // Below this the client's position is meaningless and only a full
        // snapshot is correct.
        oldestAvailable: Number(floor?.oldest || 0),
        head: Number(floor?.head || 0),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, changes: [], error: error.message });
    }
  });

  /// Everything a cold replica needs, in one compressed answer.
  ///
  /// A first launch used to fetch thirteen lists one after another — fourteen
  /// round trips with the first delta poll, on a link where a round trip is the
  /// expensive part. This answers them together, with the changelog head the
  /// replica should start from.
  ///
  /// The head is read BEFORE the lists. A write that lands while they are being
  /// read is then replayed from the changelog afterwards (a replay is an
  /// idempotent refetch), rather than being covered by a head read after it and
  /// lost.
  ///
  /// Each list is the server's own list endpoint, asked over loopback with the
  /// caller's credentials, so it keeps its own permission check and its exact
  /// shape — a second copy of thirteen list queries would drift from the first.
  /// A list the caller may not read is left out and named in `refused`; one
  /// that failed to load is named in `missing`, for the client to fetch alone.
  app.get('/api/replica/bootstrap', requireAuth, async (req, res) => {
    try {
      const head = Number((await get('SELECT MAX(id) AS head FROM changelog'))?.head || 0);
      const address = String(req.socket.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
      const host = address.includes(':') ? `[${address}]` : address;
      const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${req.socket.localPort}`;
      const headers = { authorization: req.headers.authorization || '', 'accept-encoding': 'identity' };
      // `?tables=items,units` for a replica that holds only some of them (the
      // phone's); absent, every list. A name it does not know is ignored.
      const wanted = String(req.query.tables || '').split(',').map((name) => name.trim()).filter(Boolean);
      const lists = Object.entries(REPLICA_LISTS).filter(([table]) => !wanted.length || wanted.includes(table));
      const entries = await Promise.all(lists.map(async ([table, listPath]) => {
        try {
          const response = await fetch(`${base}${listPath}`, { headers });
          if (response.status === 401 || response.status === 403) return [table, 'refused'];
          if (!response.ok) return [table, null];
          return [table, firstList(await response.json())];
        } catch (_) {
          return [table, null];
        }
      }));
      // `refused`: this caller may not read it, and asking again will not help.
      // `missing`: it failed to load; the client asks for it on its own.
      const answered = {};
      const missing = [];
      const refused = [];
      for (const [table, rows] of entries) {
        if (rows === 'refused') refused.push(table);
        else if (rows) answered[table] = rows;
        else missing.push(table);
      }
      res.json({ success: true, head, lists: answered, missing, refused, error: null });
    } catch (error) {
      res.status(500).json({ success: false, head: 0, lists: {}, missing: [], refused: [], error: error.message });
    }
  });

  app.get('/api/events', requireAuth, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Tell nginx / reverse proxies NOT to buffer this stream. Without this, small
    // change events pile up in the proxy's buffer and reach the client only when
    // it fills or the heartbeat flushes it — so live updates arrive in laggy
    // bursts. Pairs with `proxy_buffering off` in deploy/nginx.paper.conf.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Disable Nagle so each small SSE frame goes out on the wire immediately.
    req.socket?.setNoDelay(true);

    // Flush per-write when a flush() is available (e.g. behind compression);
    // harmless no-op otherwise.
    const flush = () => {
      if (typeof res.flush === 'function') res.flush();
    };

    let sinceId = Number(req.query.since);
    if (!Number.isFinite(sinceId) || sinceId < 0) {
      sinceId = null;
    }

    try {
      // Only replay when the client already holds a real position (since > 0),
      // i.e. it received live events and then reconnected. A fresh client sends
      // since=0 and just syncs to head — it does a full initial load on its own,
      // so replaying the entire changelog history would be a needless burst of
      // refetches on every app launch.
      if (sinceId !== null && sinceId > 0) {
        // Catch up on events missed while disconnected. This MUST use the same
        // framing as the live `listener` below (an `event: table-change` line and
        // table_name/record_id/event_type keys) — otherwise the client silently
        // drops every replayed event and never recovers changes made during the
        // reconnect gap. LIMIT guards against an unbounded replay for a very stale
        // client; the closing `lastChangeId` still advances it to head.
        const rows = await all('SELECT id, table_name, record_id, event_type FROM changelog WHERE id > ? ORDER BY id ASC LIMIT 1000', [sinceId]);
        for (const row of rows) {
          res.write(`id: ${row.id}\n`);
          res.write(`event: table-change\n`);
          res.write(`data: ${JSON.stringify({ table_name: row.table_name, record_id: row.record_id, event_type: row.event_type })}\n\n`);
        }
      }
      // Always tell the client the current head so it can anchor its position
      // (used on first connect, and after a capped catch-up).
      const row = await get('SELECT MAX(id) as maxId FROM changelog');
      const maxId = row?.maxId || 0;
      res.write(`data: ${JSON.stringify({ lastChangeId: maxId })}\n\n`);
      flush();
    } catch (err) {
      console.error('[SSE] Failed to fetch changelog:', err);
    }

    const listener = (event) => {
      try {
        res.write(`id: ${event.id}\n`);
        res.write(`event: table-change\n`);
        res.write(`data: ${JSON.stringify({ table_name: event.table, record_id: event.recordId, event_type: event.eventType })}\n\n`);
        flush();
      } catch (_) {
        // client connection closed
      }
    };

    const customEventListener = (payload) => {
      // An event addressed to one user (a phone's photo queue) reaches only that
      // user's own connections; everything else still goes to everyone.
      if (payload && payload.userId != null && Number(payload.userId) !== Number(req.user?.id)) return;
      try {
        res.write(`event: custom-event\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        flush();
      } catch (_) {
        // client connection closed
      }
    };

    changeEmitter.on('table-change', listener);
    changeEmitter.on('custom-event', customEventListener);

    // Heartbeat to keep the connection (and any idle proxy) alive.
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
        flush();
      } catch (_) {
        // client connection closed
      }
    }, 15000);

    req.on('close', () => {
      changeEmitter.off('table-change', listener);
      changeEmitter.off('custom-event', customEventListener);
      clearInterval(heartbeat);
    });
  });
}

module.exports = {
  registerRealtimeRoutesBeforeLogin,
  REPLICA_LISTS,
};
