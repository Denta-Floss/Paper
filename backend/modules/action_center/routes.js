'use strict';

// ---------------------------------------------------------------------------
// Action Center module — HTTP routes.
//
// All 8 route registrations for action_center territory (delete-requests, trash,
// action-center) moved VERBATIM from server.js. No logic edits; handler bodies
// are NOT re-indented. Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerActionCenterModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    requireAuth,
    get,
    all,
    run,
    parsePagination,
    approveDeleteRequestEntity,
    restoreTrashedRecord,
    scanActionCenterIssues,
  } = ctx;

app.get('/api/delete-requests', requirePermission('delete_requests.review'), async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const whereClauses = [];
    const params = [];
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      whereClauses.push('status = ?');
      params.push(status);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const countRow = await get(`SELECT COUNT(*) as count FROM delete_requests ${whereSql}`, params);
    const total = Number(countRow?.count || 0);
    const rows = await all(`SELECT * FROM delete_requests ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

    res.json({
      success: true,
      requests: rows.map(r => ({
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityLabel: r.entity_label,
        reason: r.reason,
        status: r.status,
        requestedByUserId: r.requested_by_user_id,
        reviewedByUserId: r.reviewed_by_user_id,
        reviewedAt: r.reviewed_at,
        reviewedNote: r.reviewed_note,
        createdAt: r.created_at
      })),
      total
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/delete-requests', requireAuth, async (req, res) => {
  try {
    const { entityType, entityId, entityLabel, reason } = req.body;
    if (!entityType || !entityId) {
       return res.status(400).json({ success: false, error: 'entityType and entityId are required.' });
    }
    const insertResult = await run(
      `INSERT INTO delete_requests (entity_type, entity_id, entity_label, reason, status, requested_by_user_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [entityType, entityId, entityLabel || '', reason || '', req.user.id, new Date().toISOString()]
    );
    const r = await get(`SELECT * FROM delete_requests WHERE id = ?`, [insertResult.lastID]);
    res.status(201).json({
      success: true,
      request: {
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityLabel: r.entity_label,
        reason: r.reason,
        status: r.status,
        requestedByUserId: r.requested_by_user_id,
        reviewedByUserId: r.reviewed_by_user_id,
        reviewedAt: r.reviewed_at,
        reviewedNote: r.reviewed_note,
        createdAt: r.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/delete-requests/:id/approve', requirePermission('delete_requests.review'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reqRow = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    if (!reqRow) return res.status(404).json({ success: false, error: 'Not found' });
    if (reqRow.status !== 'pending') return res.status(400).json({ success: false, error: 'Request is not pending.' });

    await approveDeleteRequestEntity(reqRow, req);

    const note = req.body?.note || '';
    const now = new Date().toISOString();
    await run(
      `UPDATE delete_requests SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = ?, reviewed_note = ? WHERE id = ?`,
      [req.user.id, now, note, id]
    );
    const r = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);

    res.json({
      success: true,
      request: {
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityLabel: r.entity_label,
        reason: r.reason,
        status: r.status,
        requestedByUserId: r.requested_by_user_id,
        reviewedByUserId: r.reviewed_by_user_id,
        reviewedAt: r.reviewed_at,
        reviewedNote: r.reviewed_note,
        createdAt: r.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/delete-requests/:id/reject', requirePermission('delete_requests.review'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const reqRow = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    if (!reqRow) return res.status(404).json({ success: false, error: 'Not found' });
    if (reqRow.status !== 'pending') return res.status(400).json({ success: false, error: 'Request is not pending.' });

    const note = req.body?.note || '';
    const now = new Date().toISOString();
    await run(
      `UPDATE delete_requests SET status = 'rejected', reviewed_by_user_id = ?, reviewed_at = ?, reviewed_note = ? WHERE id = ?`,
      [req.user.id, now, note, id]
    );
    const r = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);

    res.json({
      success: true,
      request: {
        id: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
        entityLabel: r.entity_label,
        reason: r.reason,
        status: r.status,
        requestedByUserId: r.requested_by_user_id,
        reviewedByUserId: r.reviewed_by_user_id,
        reviewedAt: r.reviewed_at,
        reviewedNote: r.reviewed_note,
        createdAt: r.created_at
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/delete-requests/export', requirePermission('delete_requests.review'), async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM delete_requests ORDER BY created_at DESC`);
    const csvHeader = 'id,entityType,entityId,entityLabel,status,createdAt,reviewedAt\n';
    const csvBody = rows.map(r => `${r.id},${r.entity_type},${r.entity_id},${r.entity_label},${r.status},${r.created_at},${r.reviewed_at || ''}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="delete_requests_export.csv"');
    res.send(csvHeader + csvBody);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/trash — list trashed records (most recent first), optionally filtered by table.
app.get('/api/trash', requirePermission('config.read'), async (req, res) => {
  try {
    const { tableName } = req.query;
    const params = [];
    let where = '';
    if (tableName) {
      where = 'WHERE table_name = ?';
      params.push(String(tableName));
    }
    const rows = await all(
      `SELECT id, table_name, record_id, data_json, deleted_at, deleted_by
       FROM deleted_records ${where} ORDER BY id DESC LIMIT 500`,
      params
    );
    const records = rows.map((r) => {
      let data = null;
      try {
        data = JSON.parse(r.data_json);
      } catch (_) {
        data = null;
      }
      return {
        id: r.id,
        tableName: r.table_name,
        recordId: r.record_id,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
        label: (data && (data.display_name || data.name || data.challan_no)) || `${r.table_name} #${r.record_id}`,
        data,
      };
    });
    res.json({ success: true, records, total: records.length, error: null });
  } catch (error) {
    res.status(500).json({ success: false, records: [], total: 0, error: error.message });
  }
});

// POST /api/trash/restore — re-insert a trashed row (original id preserved) and
// remove it from the trash. Uses a plain INSERT (never OR REPLACE) so a live row
// is never silently clobbered; FK checks are skipped so a row can be restored even
// if some of its own references are still missing (those resurface in Action Center).
app.post('/api/trash/restore', requirePermission('config.write'), async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || '');
    const recordId = Number(req.body?.recordId);
    if (!tableName || !Number.isFinite(recordId)) {
      return res.status(400).json({ success: false, error: 'tableName and recordId are required.' });
    }
    const result = await restoreTrashedRecord(tableName, recordId);
    if (!result.success) {
      return res.status(result.statusCode || 500).json({ success: false, error: result.error });
    }
    res.json({ success: true, restored: { tableName, recordId }, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/action-center/issues', requirePermission('config.read'), async (req, res) => {
  try {
    const result = await scanActionCenterIssues();
    res.json({ success: true, issues: result.issues, total: result.issues.length, scanErrors: result.scanErrors, error: null });
  } catch (error) {
    res.status(500).json({ success: false, issues: [], total: 0, scanErrors: [], error: error.message });
  }
});

};
