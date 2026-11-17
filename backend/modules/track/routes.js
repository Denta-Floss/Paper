'use strict';

// ---------------------------------------------------------------------------
// Track: the activity trail. Who did what to which record, and the older
// audit log it grew out of.
//
//   GET    /api/audit/global
//   GET    /api/track/actor/:userId
//   GET    /api/track/sittings
//   GET    /api/track/sitting/:id
//   GET    /api/track/:entityType/:id
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
function registerTrackRoutes(app, {
  actorScopeFor,
  all,
  get,
  hasPermission,
  requirePermission,
  rowToEntityActivityDto,
}) {
  app.get('/api/audit/global', requirePermission('audit.read'), async (req, res) => {
    try {
      const params = [];
      const whereClauses = [];
      const entityType = String(req.query.entityType || '').trim();
      const action = String(req.query.action || '').trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      if (entityType) {
        whereClauses.push('g.entity_type = ?');
        params.push(entityType);
      }
      if (action) {
        whereClauses.push('g.action = ?');
        params.push(action);
      }

      if (req.user.role === 'admin') {
        whereClauses.push('(g.actor_user_id = ? OR g.actor_role = ?)');
        params.push(req.user.id, 'user');
      } else if (req.user.role !== 'super_admin') {
        whereClauses.push('g.actor_user_id = ?');
        params.push(req.user.id);
      }

      const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

      const countRow = await get(
        `SELECT COUNT(*) as c FROM global_audit_logs g ${whereSql}`,
        params
      );
      const total = countRow ? countRow.c : 0;

      const rows = await all(
        `
        SELECT 
          g.id, g.actor_user_id, g.actor_name, g.actor_role, 
          g.action, g.entity_type, g.entity_id, g.details_json, 
          g.ip_address, g.created_at
        FROM global_audit_logs g
        ${whereSql}
        ORDER BY g.created_at DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      );

      const logs = rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        details: JSON.parse(r.details_json || '{}'),
        ipAddress: r.ip_address,
        createdAt: r.created_at,
      }));

      res.json({ success: true, data: logs, total, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // --- Track: per-entity + per-person activity feeds --------------------------
  // Per-person "overall" track — everything this user changed, newest first.
  // Defined before the generic /:entityType route so "actor" isn't swallowed.
  app.get('/api/track/actor/:userId', async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      // Your own trail is yours to read — the profile's Account & Access shows
      // it to everyone. Anyone else's still needs audit.read.
      if (userId !== Number(req.user?.id) && !hasPermission(req, 'audit.read')) {
        res.status(403).json({ success: false, events: [], error: 'You do not have permission to read this person\'s activity.' });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const rows = await all(
        `SELECT * FROM entity_activity_log
         WHERE actor_user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [userId, limit],
      );
      res.json({
        success: true,
        events: rows.map(rowToEntityActivityDto),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, events: [], error: error.message });
    }
  });

  app.get('/api/track/sittings', requirePermission('audit.read'), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      // One row per sitting. Grouping in SQL rather than reading every event and
      // folding in JS, because a busy workspace has far more events than
      // sittings and only the summary is wanted here.
      const scope = actorScopeFor(req);
      const rows = await all(
        `SELECT
           sitting_id AS sittingId,
           COUNT(*) AS events,
           MIN(created_at) AS startedAt,
           MAX(created_at) AS endedAt,
           MAX(actor_user_id) AS actorUserId,
           MAX(actor_name) AS actorName
         FROM entity_activity_log
         WHERE sitting_id IS NOT NULL${scope.sql ? ` AND ${scope.sql}` : ''}
         GROUP BY sitting_id
         ORDER BY MAX(created_at) DESC, sitting_id DESC
         LIMIT ?`,
        [...scope.params, limit],
      );
      res.json({ success: true, sittings: rows, error: null });
    } catch (error) {
      res.status(500).json({ success: false, sittings: [], error: error.message });
    }
  });

  app.get('/api/track/sitting/:id', requirePermission('audit.read'), async (req, res) => {
    try {
      const sittingId = String(req.params.id || '');
      const scope = actorScopeFor(req);
      const rows = await all(
        `SELECT * FROM entity_activity_log
         WHERE sitting_id = ?${scope.sql ? ` AND ${scope.sql}` : ''}
         ORDER BY created_at ASC, id ASC`,
        [sittingId, ...scope.params],
      );
      if (rows.length === 0) {
        // Not an empty list: a sitting somebody else's, and a sitting that never
        // existed, must not be told apart from one where nothing happened — and
        // "nothing happened here" is a claim this route cannot make about a
        // window it is not allowed to see.
        return res.status(404).json({
          success: false,
          events: [],
          error: 'No such sitting.',
        });
      }
      const events = rows.map(rowToEntityActivityDto);

      // A link writes one row on each side so it shows on both records' Track
      // tabs. Here that is one thing that happened, so the pair is folded back
      // into a single line — in JS, after the indexed read, because nothing
      // queries inside details_json.
      const seenPairs = new Set();
      const collapsed = [];
      for (const event of events) {
        const pairKey = event.details?.pairKey;
        if (!pairKey) {
          collapsed.push(event);
          continue;
        }
        const fold = `${event.action}|${pairKey}`;
        if (seenPairs.has(fold)) continue;
        seenPairs.add(fold);
        collapsed.push(event);
      }

      res.json({
        success: true,
        sittingId,
        events: collapsed,
        // The raw count, so a caller can tell that two rows became one line
        // rather than that a row went missing.
        rowCount: events.length,
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, events: [], error: error.message });
    }
  });

  // Per-record track — the "Track" tab on a master (Item, Vendor, Client, ...).
  app.get('/api/track/:entityType/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const entityType = String(req.params.entityType || '');
      const entityId = String(req.params.id || '');
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const rows = await all(
        `SELECT * FROM entity_activity_log
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [entityType, entityId, limit],
      );
      res.json({
        success: true,
        events: rows.map(rowToEntityActivityDto),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, events: [], error: error.message });
    }
  });
}

module.exports = {
  registerTrackRoutes,
};
