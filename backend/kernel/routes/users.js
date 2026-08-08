'use strict';

// ---------------------------------------------------------------------------
// Kernel Users, Roles & Permissions routes.
//
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

module.exports = function registerUsersKernelRoutes(ctx) {
  const {
    app,
    requirePermission,
    requireRoles,
    get,
    all,
    run,
    USER_ROLES,
    RECORD_OPTION_SOURCES,
    RECORD_PERMISSION_OPS,
    parsePagination,
    safeUserDtoWithPermissions,
    permissionDescriptors,
    normalizePermissionKey,
    isKnownPermissionKey,
    nowIso,
    canManageUser,
    getAssignedPermissionTemplates,
    getUserPermissionSnapshot,
    createEmptyPermissionMap,
    getRolePermissionMap,
    getTemplatePermissionMapForUser,
    parseBooleanFlag,
    logAuthEvent,
    getRequestIp,
    getRequestUserAgent,
    createUserAccount,
    validatePasswordPolicy,
    hashPassword,
    revokeSessionsForUser,
  } = ctx;

app.get('/api/users', requirePermission('users.read'), async (req, res) => {
  try {
    const params = [];
    const whereClauses = [];
    const queryText = String(req.query.query || '').trim().toLowerCase();
    const role = String(req.query.role || '').trim();
    const isActiveRaw = String(req.query.isActive || '').trim().toLowerCase();
    if (queryText) {
      whereClauses.push('(LOWER(users.name) LIKE ? OR LOWER(email) LIKE ?)');
      params.push(`%${queryText}%`, `%${queryText}%`);
    }
    if (USER_ROLES.has(role)) {
      whereClauses.push('users.role = ?');
      params.push(role);
    }
    if (isActiveRaw === 'true' || isActiveRaw === 'false') {
      whereClauses.push('users.is_active = ?');
      params.push(isActiveRaw === 'true' ? 1 : 0);
    }
    if (req.user.role === 'admin') {
      whereClauses.push('(users.role = ? OR users.id = ?)');
      params.push('user', req.user.id);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
    const countRow = await get(`SELECT COUNT(*) AS count FROM users ${whereSql}`, params);
    const total = Number(countRow?.count || 0);
    const rows = await all(
      `
      SELECT users.*, clients.name as client_name
      FROM users
      LEFT JOIN clients ON users.client_id = clients.id
      ${whereSql}
      ORDER BY users.role ASC, users.name ASC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );
    const users = [];
    for (const row of rows) {
      users.push(await safeUserDtoWithPermissions(row));
    }
    res.json({
      success: true,
      users,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + users.length < total,
      },
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, users: [], error: error.message });
  }
});

app.get('/api/permissions', requirePermission('users.manage_permissions'), async (_req, res) => {
  res.json({
    success: true,
    permissions: permissionDescriptors(),
    error: null,
  });
});

app.get('/api/permission-templates', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const queryText = String(req.query.query || '').trim().toLowerCase();
    const params = [];
    let whereSql = '';
    if (queryText) {
      whereSql = 'WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ?';
      params.push(`%${queryText}%`, `%${queryText}%`);
    }
    const rows = await all(
      `
      SELECT *
      FROM permission_templates
      ${whereSql}
      ORDER BY name ASC
      `,
      params,
    );
    const templates = [];
    for (const row of rows) {
      const permissionRows = await all(
        `
        SELECT permission_key, is_allowed
        FROM permission_template_permissions
        WHERE template_id = ?
        ORDER BY permission_key ASC
        `,
        [row.id],
      );
      templates.push({
        id: row.id,
        name: row.name || '',
        description: row.description || '',
        isSystemDefault: Number(row.is_system_default || 0) === 1,
        permissions: permissionRows
          .filter((item) => Number(item.is_allowed || 0) === 1)
          .map((item) => String(item.permission_key || '').trim())
          .filter(Boolean),
      });
    }
    res.json({ success: true, templates, error: null });
  } catch (error) {
    res.status(500).json({ success: false, templates: [], error: error.message });
  }
});

function normalizeTemplatePermissionKeys(input) {
  const requested = Array.isArray(input)
    ? input
    : Object.entries(input || {})
        .filter(([, v]) => v === true)
        .map(([k]) => k);
  return [
    ...new Set(
      requested.map((k) => normalizePermissionKey(k)).filter(isKnownPermissionKey),
    ),
  ];
}

function firstUngrantableKey(req, keys) {
  if (req.user.role === 'super_admin') return null;
  return keys.find((k) => req.userPermissions?.[k] !== true) || null;
}

app.post('/api/permission-templates', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'A name is required.' });
    const description = String(req.body?.description || '').trim();
    const keys = normalizeTemplatePermissionKeys(req.body?.permissions);
    const lacking = firstUngrantableKey(req, keys);
    if (lacking) {
      return res.status(403).json({ success: false, error: `You cannot grant a permission you do not have (${lacking}).` });
    }
    const existing = await get('SELECT id FROM permission_templates WHERE LOWER(name) = LOWER(?)', [name]);
    if (existing) return res.status(409).json({ success: false, error: 'A preset with that name already exists.' });
    const now = nowIso();
    const info = await run(
      'INSERT INTO permission_templates (name, description, is_system_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
      [name, description, now, now],
    );
    const templateId = info.lastID;
    for (const key of keys) {
      await run(
        'INSERT INTO permission_template_permissions (template_id, permission_key, is_allowed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        [templateId, key, now, now],
      );
    }
    res.status(201).json({ success: true, id: templateId, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/permission-templates/:id', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tpl = await get('SELECT * FROM permission_templates WHERE id = ?', [id]);
    if (!tpl) return res.status(404).json({ success: false, error: 'Preset not found.' });
    if (Number(tpl.is_system_default || 0) === 1) {
      return res.status(403).json({ success: false, error: 'Built-in presets cannot be edited.' });
    }
    const now = nowIso();
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : tpl.name;
    if (!name) return res.status(400).json({ success: false, error: 'A name is required.' });
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : tpl.description;
    await run('UPDATE permission_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?', [name, description, now, id]);
    if (req.body?.permissions !== undefined) {
      const keys = normalizeTemplatePermissionKeys(req.body.permissions);
      const lacking = firstUngrantableKey(req, keys);
      if (lacking) {
        return res.status(403).json({ success: false, error: `You cannot grant a permission you do not have (${lacking}).` });
      }
      await run('DELETE FROM permission_template_permissions WHERE template_id = ?', [id]);
      for (const key of keys) {
        await run(
          'INSERT INTO permission_template_permissions (template_id, permission_key, is_allowed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
          [id, key, now, now],
        );
      }
    }
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/permission-templates/:id', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const tpl = await get('SELECT * FROM permission_templates WHERE id = ?', [id]);
    if (!tpl) return res.status(404).json({ success: false, error: 'Preset not found.' });
    if (Number(tpl.is_system_default || 0) === 1) {
      return res.status(403).json({ success: false, error: 'Built-in presets cannot be deleted.' });
    }
    await run('DELETE FROM permission_template_permissions WHERE template_id = ?', [id]);
    await run('DELETE FROM user_permission_templates WHERE template_id = ?', [id]);
    await run('DELETE FROM permission_templates WHERE id = ?', [id]);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/:id/permission-templates', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, templates: [], error: 'User not found.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, templates: [], error: 'You do not have permission to manage this user.' });
      return;
    }
    const assignedRows = await getAssignedPermissionTemplates(targetId);
    const assignedTemplateIds = assignedRows.map((row) => Number(row.id));
    res.json({
      success: true,
      assignedTemplateIds,
      assignedTemplates: assignedRows.map((row) => ({
        id: row.id,
        name: row.name || '',
        description: row.description || '',
      })),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, templates: [], error: error.message });
  }
});

app.patch('/api/users/:id/permission-templates', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, error: 'You do not have permission to manage this user.' });
      return;
    }
    if (target.role === 'super_admin') {
      res.status(403).json({ success: false, error: 'Super admin templates cannot be edited.' });
      return;
    }
    const templateIds = Array.isArray(req.body?.templateIds)
      ? [...new Set(req.body.templateIds.map((value) => Number(value)).filter((value) => value > 0))]
      : null;
    if (!templateIds) {
      res.status(400).json({ success: false, error: 'templateIds array is required.' });
      return;
    }
    if (templateIds.length > 0) {
      const placeholders = templateIds.map(() => '?').join(', ');
      const templateRows = await all(
        `
        SELECT DISTINCT pt.id, ptp.permission_key, ptp.is_allowed
        FROM permission_templates pt
        LEFT JOIN permission_template_permissions ptp ON ptp.template_id = pt.id
        WHERE pt.id IN (${placeholders})
        `,
        templateIds,
      );
      const foundTemplateIds = new Set(templateRows.map((row) => Number(row.id)));
      if (foundTemplateIds.size !== templateIds.length) {
        res.status(400).json({ success: false, error: 'One or more templates were not found.' });
        return;
      }
      if (req.user.role !== 'super_admin') {
        for (const row of templateRows) {
          const key = normalizePermissionKey(row.permission_key);
          if (!key || Number(row.is_allowed || 0) !== 1) {
            continue;
          }
          if (req.userPermissions?.[key] !== true) {
            res.status(403).json({
              success: false,
              error: `You cannot assign template permissions you do not have: ${key}`,
            });
            return;
          }
        }
      }
    }
    await run('DELETE FROM user_permission_templates WHERE user_id = ?', [targetId]);
    const now = nowIso();
    for (const templateId of templateIds) {
      await run(
        `
        INSERT INTO user_permission_templates (user_id, template_id, created_at)
        VALUES (?, ?, ?)
        `,
        [targetId, templateId, now],
      );
    }
    await logAuthEvent({
      eventType: 'permission_templates_updated',
      actorUserId: req.user.id,
      targetUserId: targetId,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: { templateIds },
    });
    res.json({ success: true, templateIds, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/:id/permissions', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, permissions: [], error: 'User not found.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, permissions: [], error: 'You do not have permission to manage this user.' });
      return;
    }
    const permissions = await getUserPermissionSnapshot(target);
    const assignedTemplates = await getAssignedPermissionTemplates(targetId);
    res.json({
      success: true,
      permissions,
      assignedTemplates: assignedTemplates.map((row) => ({
        id: row.id,
        name: row.name || '',
        description: row.description || '',
      })),
      role: target.role,
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, permissions: [], error: error.message });
  }
});

app.get('/api/users/:id/record-permissions', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ success: false, records: [], error: 'User not found.' });
    if (!canManageUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, records: [], error: 'You do not have permission to manage this user.' });
    }
    const rows = await all(
      'SELECT entity_type, entity_id, op FROM user_record_permissions WHERE user_id = ? ORDER BY entity_type, entity_id',
      [targetId],
    );
    const records = [];
    for (const r of rows) {
      const src = RECORD_OPTION_SOURCES[r.entity_type];
      let label = `#${r.entity_id}`;
      if (src) {
        try {
          const row = await get(`SELECT ${src.label} AS label FROM ${src.table} WHERE ${src.idCol || 'id'} = ?`, [r.entity_id]);
          if (row && row.label) label = row.label;
        } catch (_) {}
      }
      records.push({ entityType: r.entity_type, entityId: String(r.entity_id), op: r.op, label });
    }
    res.json({ success: true, records, error: null });
  } catch (error) {
    res.status(500).json({ success: false, records: [], error: error.message });
  }
});

app.put('/api/users/:id/record-permissions', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ success: false, error: 'User not found.' });
    if (!canManageUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'You do not have permission to manage this user.' });
    }
    const requested = Array.isArray(req.body?.records) ? req.body.records : [];
    const clean = [];
    for (const r of requested) {
      const entityType = String(r?.entityType || '').trim();
      const entityId = String(r?.entityId ?? '').trim();
      const op = String(r?.op || '').trim();
      if (!RECORD_OPTION_SOURCES[entityType] || !RECORD_PERMISSION_OPS.has(op) || !entityId) continue;
      if (req.user.role !== 'super_admin' && req.userPermissions?.[`${entityType}.${op}`] !== true) {
        return res.status(403).json({ success: false, error: `You cannot grant ${op} on ${entityType} that you do not have yourself.` });
      }
      clean.push({ entityType, entityId, op });
    }
    const now = nowIso();
    await run('DELETE FROM user_record_permissions WHERE user_id = ?', [targetId]);
    for (const r of clean) {
      await run(
        'INSERT OR IGNORE INTO user_record_permissions (user_id, entity_type, entity_id, op, created_at) VALUES (?, ?, ?, ?, ?)',
        [targetId, r.entityType, r.entityId, r.op, now],
      );
    }
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/record-options/:entityType', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const src = RECORD_OPTION_SOURCES[String(req.params.entityType)];
    if (!src) return res.json({ success: true, options: [], error: null });
    const q = String(req.query.query || '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const params = [];
    let where = '';
    if (q) {
      where = `WHERE LOWER(${src.label}) LIKE ?`;
      params.push(`%${q}%`);
    }
    params.push(limit);
    const rows = await all(
      `SELECT ${src.idCol || 'id'} AS id, ${src.label} AS label FROM ${src.table} ${where} ORDER BY label LIMIT ?`,
      params,
    );
    res.json({
      success: true,
      options: rows.map((r) => ({ id: String(r.id), label: r.label || `#${r.id}` })),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, options: [], error: error.message });
  }
});

app.patch('/api/users/:id/permissions', requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, permissions: [], error: 'User not found.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, permissions: [], error: 'You do not have permission to manage this user.' });
      return;
    }
    if (target.role === 'super_admin') {
      res.status(403).json({ success: false, permissions: [], error: 'Super admin permissions cannot be edited.' });
      return;
    }

    const patchItems = Array.isArray(req.body?.overrides) ? req.body.overrides : null;
    if (!patchItems) {
      res.status(400).json({ success: false, permissions: [], error: 'overrides array is required.' });
      return;
    }

    const actorCanGrant = req.userPermissions || createEmptyPermissionMap();
    const targetRoleDefaults = await getRolePermissionMap(target.role);
    const targetTemplateDefaults = await getTemplatePermissionMapForUser(targetId);
    const now = nowIso();
    for (const item of patchItems) {
      const key = normalizePermissionKey(item?.key);
      if (!isKnownPermissionKey(key)) {
        res.status(400).json({ success: false, permissions: [], error: `Unknown permission key: ${key}` });
        return;
      }
      const allowed = parseBooleanFlag(item?.allowed);
      if (req.user.role !== 'super_admin' && allowed && actorCanGrant[key] !== true) {
        res.status(403).json({ success: false, permissions: [], error: `You cannot grant permission you do not have: ${key}` });
        return;
      }
      const baselineAllowed =
        targetRoleDefaults[key] === true || targetTemplateDefaults[key] === true;
      if (allowed === baselineAllowed) {
        await run(
          'DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_key = ?',
          [targetId, key],
        );
      } else {
        await run(
          `
          INSERT INTO user_permission_overrides (user_id, permission_key, is_allowed, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, permission_key)
          DO UPDATE SET is_allowed = excluded.is_allowed, updated_at = excluded.updated_at
          `,
          [targetId, key, allowed ? 1 : 0, now, now],
        );
      }
    }

    await logAuthEvent({
      eventType: 'permissions_updated',
      actorUserId: req.user.id,
      targetUserId: targetId,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: { updatedKeys: patchItems.map((item) => normalizePermissionKey(item?.key)).filter(Boolean) },
    });

    const refreshedTarget = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    const permissions = await getUserPermissionSnapshot(refreshedTarget);
    res.json({ success: true, permissions, role: refreshedTarget.role, error: null });
  } catch (error) {
    res.status(500).json({ success: false, permissions: [], error: error.message });
  }
});

app.post('/api/admins', requireRoles('super_admin'), requirePermission('users.create_admin'), async (req, res) => {
  try {
    const user = await createUserAccount({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      role: 'admin',
      createdByUserId: req.user.id,
    });
    await logAuthEvent({
      eventType: 'user_created',
      actorUserId: req.user.id,
      targetUserId: user.id,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: { role: 'admin' },
    });
    res.status(201).json({ success: true, user: await safeUserDtoWithPermissions(user), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, user: null, error: error.message });
  }
});

app.post('/api/users', requireRoles('super_admin', 'admin'), requirePermission('users.create_user'), async (req, res) => {
  try {
    const user = await createUserAccount({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      role: 'user',
      createdByUserId: req.user.id,
    });
    await logAuthEvent({
      eventType: 'user_created',
      actorUserId: req.user.id,
      targetUserId: user.id,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: { role: 'user' },
    });
    res.status(201).json({ success: true, user: await safeUserDtoWithPermissions(user), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, user: null, error: error.message });
  }
});

app.delete('/api/users/:id', requireRoles('super_admin', 'admin'), requirePermission('users.manage_permissions'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const override = req.query.override === 'true';
    if (!override) {
       return res.status(400).json({ success: false, error: 'User deletion requires override flag for compliance reasons.' });
    }
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account.' });
    }
    if (!canManageUser(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'You can only delete accounts below your own role level.' });
    }

    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, `user_${targetId}_backup.json`), JSON.stringify(target, null, 2));

    await run('BEGIN TRANSACTION');
    try {
      await run('DELETE FROM auth_sessions WHERE user_id = ?', [targetId]);
      await run('DELETE FROM user_permission_overrides WHERE user_id = ?', [targetId]);
      await run('DELETE FROM user_permission_templates WHERE user_id = ?', [targetId]);
      await run('UPDATE auth_events SET actor_user_id = NULL WHERE actor_user_id = ?', [targetId]);
      await run('UPDATE auth_events SET target_user_id = NULL WHERE target_user_id = ?', [targetId]);
      await run('UPDATE global_audit_logs SET actor_user_id = NULL WHERE actor_user_id = ?', [targetId]);
      await run('UPDATE delete_requests SET reviewed_by_user_id = NULL WHERE reviewed_by_user_id = ?', [targetId]);
      await run('DELETE FROM delete_requests WHERE requested_by_user_id = ?', [targetId]);
      await run('UPDATE users SET created_by_user_id = NULL WHERE created_by_user_id = ?', [targetId]);
      await run('UPDATE procurement_requests SET created_by_user_id = NULL WHERE created_by_user_id = ?', [targetId]);
      await run('UPDATE procurement_requests SET raised_by_user_id = NULL WHERE raised_by_user_id = ?', [targetId]);
      await run('UPDATE procurement_requests SET cancelled_by_user_id = NULL WHERE cancelled_by_user_id = ?', [targetId]);
      await run('UPDATE procurement_requests SET closed_by_user_id = NULL WHERE closed_by_user_id = ?', [targetId]);
      await run('UPDATE procurement_activity_log SET actor_user_id = NULL WHERE actor_user_id = ?', [targetId]);
      await run('UPDATE delivery_challans SET created_by = NULL WHERE created_by = ?', [targetId]);
      await run('UPDATE delivery_challans SET updated_by = NULL WHERE updated_by = ?', [targetId]);
      await run('DELETE FROM search_history WHERE user_id = ?', [targetId]);
      await run('DELETE FROM search_clicks WHERE user_id = ?', [targetId]);
      
      await run('DELETE FROM users WHERE id = ?', [targetId]);
      await run('COMMIT');
    } catch (e) {
      await run('ROLLBACK');
      throw e;
    }
    
    await logAuthEvent({
      eventType: 'user_deleted',
      actorUserId: req.user.id,
      targetUserId: targetId,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
      metadata: { note: 'compliance override delete with backup' },
    });
    
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/users/:id/password', requirePermission('users.reset_password'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, error: 'You can only reset passwords for accounts below your own role level.' });
      return;
    }
    const newPassword = String(req.body?.newPassword || req.body?.password || '');
    const passwordError = validatePasswordPolicy(newPassword, { email: target.email, role: target.role });
    if (passwordError) {
      res.status(400).json({ success: false, error: passwordError });
      return;
    }
    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(newPassword),
      new Date().toISOString(),
      targetId,
    ]);
    await revokeSessionsForUser(targetId, { reason: 'password_reset' });
    await logAuthEvent({
      eventType: 'password_reset',
      actorUserId: req.user.id,
      targetUserId: targetId,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
    });
    res.json({
      success: true,
      user: await safeUserDtoWithPermissions(await get('SELECT * FROM users WHERE id = ?', [targetId])),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/users/:id/status', requirePermission('users.update_status'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!target) {
      res.status(404).json({ success: false, user: null, error: 'User not found.' });
      return;
    }
    if (targetId === req.user.id) {
      res.status(400).json({ success: false, user: null, error: 'You cannot deactivate your own account.' });
      return;
    }
    if (!canManageUser(req.user.role, target.role)) {
      res.status(403).json({ success: false, user: null, error: 'You can only update accounts below your own role level.' });
      return;
    }
    await run('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', [
      req.body?.isActive === false ? 0 : 1,
      new Date().toISOString(),
      targetId,
    ]);
    const isActive = req.body?.isActive === false ? false : true;
    if (!isActive) {
      await revokeSessionsForUser(targetId, { reason: 'user_deactivated' });
    }
    await logAuthEvent({
      eventType: isActive ? 'user_activated' : 'user_deactivated',
      actorUserId: req.user.id,
      targetUserId: targetId,
      ipAddress: getRequestIp(req),
      userAgent: getRequestUserAgent(req),
    });
    res.json({
      success: true,
      user: await safeUserDtoWithPermissions(await get('SELECT * FROM users WHERE id = ?', [targetId])),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, user: null, error: error.message });
  }
});

};
