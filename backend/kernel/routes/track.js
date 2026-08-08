'use strict';

// ---------------------------------------------------------------------------
// Kernel Audit & Track routes.
//
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

module.exports = function registerTrackKernelRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    rowToEntityActivityDto,
  } = ctx;

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

app.get('/api/track/actor/:userId', requirePermission('audit.read'), async (req, res) => {
  try {
    const userId = Number(req.params.userId);
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

};
