'use strict';

// ---------------------------------------------------------------------------
// Accounts: signing in and out, the people who can, what each may do.
//
// Sessions, users and admins, a user's own account, the permission catalogue and
// the named permission presets an admin writes.
//
//   POST   /api/auth/login
//   GET    /api/auth/me
//   POST   /api/auth/logout
//   GET    /api/auth/sessions
//   DELETE /api/auth/sessions/:id
//   GET    /api/users/:id/sessions
//   POST   /api/users/:id/sessions/revoke
//   GET    /api/auth/events
//   GET    /api/auth/events/export
//   PATCH  /api/me/password
//   GET    /api/users
//   GET    /api/permissions
//   GET    /api/permission-templates
//   POST   /api/permission-templates
//   PATCH  /api/permission-templates/:id
//   DELETE /api/permission-templates/:id
//   GET    /api/users/:id/permission-templates
//   PATCH  /api/users/:id/permission-templates
//   GET    /api/users/:id/permissions
//   GET    /api/users/:id/record-permissions
//   PUT    /api/users/:id/record-permissions
//   GET    /api/record-options/:entityType
//   PATCH  /api/users/:id/permissions
//   POST   /api/admins
//   POST   /api/users
//   DELETE /api/users/:id
//   PATCH  /api/users/:id/password
//   PATCH  /api/users/:id/status
//   POST   /api/me/clear-data
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
// These are registered ahead of the login gate: they answer without a session.
function registerAccountsRoutesBeforeLogin(app, {
  createAuthSession,
  get,
  getEffectivePermissionMap,
  getRequestIp,
  getRequestUserAgent,
  isTimestampInFuture,
  logAuthEvent,
  normalizeEmail,
  registerLoginFailure,
  safeUserDto,
  verifyPassword,
}) {
  app.post('/api/auth/login', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || '');
      const pin = String(req.body?.pin || '').trim();

      let user;
      if (pin && pin.length === 4) {
        // Code login: match the user's assigned 4-digit code. (No hardcoded
        // master PIN — that was a backdoor into the super admin account.)
        user = await get('SELECT * FROM users WHERE mobile_pin = ?', [pin]);
      } else {
        user = await get('SELECT * FROM users WHERE email = ?', [email]);
      }

      if (user && isTimestampInFuture(user.lockout_until)) {
        await logAuthEvent({
          eventType: 'login_blocked_lockout',
          targetUserId: user.id,
          ipAddress: getRequestIp(req),
          userAgent: getRequestUserAgent(req),
          metadata: { lockoutUntil: user.lockout_until },
        });
        res.status(423).json({ success: false, user: null, token: null, error: 'Account is temporarily locked. Try again later.' });
        return;
      }

      if (pin && pin.length === 4) {
        if (!user || Number(user.is_active || 0) !== 1) {
          await registerLoginFailure({ user, email: 'pin-login', req });
          res.status(401).json({ success: false, user: null, token: null, error: 'Invalid PIN.' });
          return;
        }
      } else {
        if (!user || Number(user.is_active || 0) !== 1 || !verifyPassword(password, user.password_hash)) {
          await registerLoginFailure({ user, email, req });
          res.status(401).json({ success: false, user: null, token: null, error: 'Invalid email or password.' });
          return;
        }
      }
      const permissionMap = await getEffectivePermissionMap(user.id, user.role);

      const clientPlatform = (req.headers['x-client-platform'] || '').toLowerCase();
      const isMobile = clientPlatform === 'mobile' || clientPlatform === 'ios' || clientPlatform === 'android';
    
      if (isMobile) {
        if (permissionMap['login.mobile'] !== true && user.role !== 'super_admin') {
          res.status(403).json({ success: false, user: null, token: null, error: 'Mobile login is disabled for this account.' });
          return;
        }
      } else {
        if (permissionMap['login.desktop'] !== true && user.role !== 'super_admin') {
          res.status(403).json({ success: false, user: null, token: null, error: 'Desktop login is disabled for this account.' });
          return;
        }
      }

      const safeUser = safeUserDto(user, permissionMap);
      const { token } = await createAuthSession({ user, req });
      res.json({ success: true, user: safeUser, token, error: null });
    } catch (error) {
      res.status(500).json({ success: false, user: null, token: null, error: error.message });
    }
  });
}

// `serverDir` is the backend's own directory (where server.js is): files these
// handlers read or write are found from there, not from this module's folder.
function registerAccountsRoutes(app, {
  RECORD_OPTION_SOURCES,
  RECORD_PERMISSION_OPS,
  USER_ROLES,
  all,
  canManageUser,
  createEmptyPermissionMap,
  createUserAccount,
  firstUngrantableKey,
  get,
  getAssignedPermissionTemplates,
  getRequestIp,
  getRequestUserAgent,
  getRolePermissionMap,
  getTemplatePermissionMapForUser,
  getUserPermissionSnapshot,
  hashPassword,
  isKnownPermissionKey,
  logAuthEvent,
  normalizeNullableDate,
  normalizePermissionKey,
  normalizeTemplatePermissionKeys,
  nowIso,
  parseBooleanFlag,
  parsePagination,
  permissionDescriptors,
  requireAuth,
  requirePermission,
  requireRoles,
  revokeSession,
  revokeSessionsForUser,
  rowToAuthEventDto,
  rowToAuthSessionDto,
  run,
  safeUserDtoWithPermissions,
  toCsv,
  validatePasswordPolicy,
  verifyPassword,
  serverDir,
}) {
  app.get('/api/auth/me', async (req, res) => {
    res.json({ success: true, user: req.user, error: null });
  });

  app.post('/api/auth/logout', async (req, res) => {
    try {
      await revokeSession(req.authSession.id, 'logout');
      await logAuthEvent({
        eventType: 'logout',
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
        metadata: { sessionId: req.authSession.id },
      });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/auth/sessions', async (req, res) => {
    try {
      const rows = await all(
        `
        SELECT *
        FROM auth_sessions
        WHERE user_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 50
        `,
        [req.user.id],
      );
      res.json({
        success: true,
        sessions: rows.map(rowToAuthSessionDto),
        // Which of them is this request's own, so a list can say "this device".
        currentSessionId: req.authSession?.id || null,
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, sessions: [], error: error.message });
    }
  });

  app.delete('/api/auth/sessions/:id', async (req, res) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      const existing = await get('SELECT * FROM auth_sessions WHERE id = ? AND user_id = ?', [
        sessionId,
        req.user.id,
      ]);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Session not found.' });
        return;
      }
      await revokeSession(sessionId, 'user_revoked');
      await logAuthEvent({
        eventType: 'session_revoked',
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
        metadata: { sessionId },
      });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/users/:id/sessions', requirePermission('sessions.manage'), async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
      if (!target) {
        res.status(404).json({ success: false, sessions: [], error: 'User not found.' });
        return;
      }
      if (!canManageUser(req.user.role, target.role) && targetId !== req.user.id) {
        res.status(403).json({ success: false, sessions: [], error: 'You do not have permission to view this user sessions.' });
        return;
      }
      const rows = await all(
        `
        SELECT *
        FROM auth_sessions
        WHERE user_id = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 100
        `,
        [targetId],
      );
      res.json({ success: true, sessions: rows.map(rowToAuthSessionDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, sessions: [], error: error.message });
    }
  });

  app.post('/api/users/:id/sessions/revoke', requirePermission('sessions.manage'), async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      const target = await get('SELECT * FROM users WHERE id = ?', [targetId]);
      if (!target) {
        res.status(404).json({ success: false, error: 'User not found.' });
        return;
      }
      if (!canManageUser(req.user.role, target.role) && targetId !== req.user.id) {
        res.status(403).json({ success: false, error: 'You do not have permission to revoke this user sessions.' });
        return;
      }
      await revokeSessionsForUser(targetId, {
        exceptSessionId: targetId === req.user.id ? req.authSession.id : null,
        reason: 'admin_revoked',
      });
      await logAuthEvent({
        eventType: 'user_sessions_revoked',
        actorUserId: req.user.id,
        targetUserId: targetId,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
      });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/auth/events', requirePermission('audit.read'), async (req, res) => {
    try {
      const params = [];
      const whereClauses = [];
      const eventType = String(req.query.eventType || '').trim();
      const targetUserId = Number(req.query.targetUserId || 0);
      const actorUserId = Number(req.query.actorUserId || 0);
      const from = normalizeNullableDate(req.query.from);
      const to = normalizeNullableDate(req.query.to);
      const { limit, offset } = parsePagination(req.query, {
        defaultLimit: 50,
        maxLimit: 200,
      });
      if (eventType) {
        whereClauses.push('ae.event_type = ?');
        params.push(eventType);
      }
      if (targetUserId > 0) {
        whereClauses.push('ae.target_user_id = ?');
        params.push(targetUserId);
      }
      if (actorUserId > 0) {
        whereClauses.push('ae.actor_user_id = ?');
        params.push(actorUserId);
      }
      if (from) {
        whereClauses.push('datetime(ae.created_at) >= datetime(?)');
        params.push(from);
      }
      if (to) {
        whereClauses.push('datetime(ae.created_at) <= datetime(?)');
        params.push(to);
      }
      if (req.user.role === 'admin') {
        whereClauses.push(`(
          ae.actor_user_id = ? OR ae.target_user_id = ?
          OR actor.role = 'user' OR target.role = 'user'
        )`);
        params.push(req.user.id, req.user.id);
      }
      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const countRow = await get(
        `
        SELECT COUNT(*) AS count
        FROM auth_events ae
        LEFT JOIN users actor ON actor.id = ae.actor_user_id
        LEFT JOIN users target ON target.id = ae.target_user_id
        ${whereSql}
        `,
        params,
      );
      const total = Number(countRow?.count || 0);
      const rows = await all(
        `
        SELECT
          ae.*,
          actor.name AS actor_user_name,
          actor.role AS actor_role,
          target.name AS target_user_name,
          target.role AS target_role
        FROM auth_events ae
        LEFT JOIN users actor ON actor.id = ae.actor_user_id
        LEFT JOIN users target ON target.id = ae.target_user_id
        ${whereSql}
        ORDER BY datetime(ae.created_at) DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset],
      );
      res.json({
        success: true,
        events: rows.map(rowToAuthEventDto),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + rows.length < total,
        },
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, events: [], error: error.message });
    }
  });

  app.get('/api/auth/events/export', requirePermission('audit.read'), async (req, res) => {
    try {
      const rows = await all(
        `
        SELECT
          ae.*,
          actor.name AS actor_user_name,
          target.name AS target_user_name
        FROM auth_events ae
        LEFT JOIN users actor ON actor.id = ae.actor_user_id
        LEFT JOIN users target ON target.id = ae.target_user_id
        ORDER BY datetime(ae.created_at) DESC
        LIMIT 5000
        `,
      );
      const csv = toCsv(
        [
          'id',
          'created_at',
          'event_type',
          'actor_user_id',
          'actor_user_name',
          'target_user_id',
          'target_user_name',
          'ip_address',
          'user_agent',
          'metadata_json',
        ],
        rows.map((row) => [
          row.id,
          row.created_at,
          row.event_type,
          row.actor_user_id ?? '',
          row.actor_user_name || '',
          row.target_user_id ?? '',
          row.target_user_name || '',
          row.ip_address || '',
          row.user_agent || '',
          row.metadata_json || '{}',
        ]),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="auth-events-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.status(200).send(csv);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/me/password', async (req, res) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const nextPassword = String(req.body?.newPassword || '');
      const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        res.status(401).json({ success: false, error: 'Current password is incorrect.' });
        return;
      }
      const passwordError = validatePasswordPolicy(nextPassword, { email: user.email, role: user.role });
      if (passwordError) {
        res.status(400).json({ success: false, error: passwordError });
        return;
      }
      await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
        hashPassword(nextPassword),
        new Date().toISOString(),
        req.user.id,
      ]);
      await revokeSessionsForUser(req.user.id, {
        exceptSessionId: req.authSession.id,
        reason: 'password_changed',
      });
      await logAuthEvent({
        eventType: 'password_changed',
        actorUserId: req.user.id,
        targetUserId: req.user.id,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
      });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

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

  // --- Per-record (row-level) grants for a single user -----------------------
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

  // Searchable record list for the per-record picker (id + label per module).
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
      const backupDir = path.join(serverDir, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
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

  // Personal data reset: any signed-in user (including staff) can wipe THEIR OWN
  // account-scoped data — favorites and search history — without touching shared
  // business records. Admins use /api/admin/clear-data for a full workspace wipe.
  app.post('/api/me/clear-data', requireAuth, async (req, res) => {
    try {
      const userId = req.user.id;
      await run('BEGIN TRANSACTION');
      try {
        await run('DELETE FROM user_favorite_items WHERE user_id = ?', [userId]);
        await run('DELETE FROM search_history WHERE user_id = ?', [userId]);
        await run('DELETE FROM search_clicks WHERE user_id = ?', [userId]);
        await run('COMMIT');
      } catch (inner) {
        await run('ROLLBACK');
        throw inner;
      }
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerAccountsRoutesBeforeLogin,
  registerAccountsRoutes,
};
