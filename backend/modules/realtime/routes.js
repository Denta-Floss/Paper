'use strict';

// ---------------------------------------------------------------------------
// Realtime: how a client hears that something changed. The change log a
// replica catches up from, and the event stream it stays connected to.
//
//   GET    /api/changes
//   GET    /api/events
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
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
};
