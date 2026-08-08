'use strict';

// ---------------------------------------------------------------------------
// Kernel Auth & Session routes.
//
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

module.exports = function registerAuthKernelRoutes(ctx) {
  const {
    app,
    requireAuth,
    requirePermission,
    get,
    all,
    run,
    normalizeEmail,
    verifyPassword,
    hashPassword,
    validatePasswordPolicy,
    getEffectivePermissionMap,
    safeUserDto,
    createAuthSession,
    revokeSession,
    logAuthEvent,
    getRequestIp,
    getRequestUserAgent,
    isTimestampInFuture,
    registerLoginFailure,
    rowToAuthSessionDto,
    rowToAuthEventDto,
    normalizeNullableDate,
    parsePagination,
    toCsv,
    changeEmitter,
    canManageUser,
    revokeSessionsForUser,
    requireApiModulePermission,
    requireApiWritePermission,
    logGlobalAudit,
  } = ctx;

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const pin = String(req.body?.pin || '').trim();

    let user;
    if (pin && pin.length === 4) {
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

app.get('/api/events', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket?.setNoDelay(true);

  const flush = () => {
    if (typeof res.flush === 'function') res.flush();
  };

  let sinceId = Number(req.query.since);
  if (!Number.isFinite(sinceId) || sinceId < 0) {
    sinceId = null;
  }

  try {
    if (sinceId !== null && sinceId > 0) {
      const rows = await all('SELECT id, table_name, record_id, event_type FROM changelog WHERE id > ? ORDER BY id ASC LIMIT 1000', [sinceId]);
      for (const row of rows) {
        res.write(`id: ${row.id}\n`);
        res.write(`event: table-change\n`);
        res.write(`data: ${JSON.stringify({ table_name: row.table_name, record_id: row.record_id, event_type: row.event_type })}\n\n`);
      }
    }
    const row = await get('SELECT MAX(id) as maxId FROM changelog');
    const maxId = row?.maxId || 0;
    res.write(`data: ${JSON.stringify({ lastChangeId: maxId })}\n\n`);
    flush();
  } catch (err) {
    console.error('[SSE] Failed to fetch changelog:', err);
  }

  const listener = (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`event: table-change\n`);
    res.write(`data: ${JSON.stringify({ table_name: event.table, record_id: event.recordId, event_type: event.eventType })}\n\n`);
    flush();
  };

  const customEventListener = (payload) => {
    res.write(`event: custom-event\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    flush();
  };

  changeEmitter.on('table-change', listener);
  changeEmitter.on('custom-event', customEventListener);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
    flush();
  }, 15000);

  req.on('close', () => {
    changeEmitter.off('table-change', listener);
    changeEmitter.off('custom-event', customEventListener);
    clearInterval(heartbeat);
  });
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use('/api', requireAuth);
app.use('/api', requireApiModulePermission);
app.use('/api', requireApiWritePermission);

app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const originalSend = res.send;
    res.send = function (body) {
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.success === false) {
            // It failed logically even if HTTP status was 200, skip logging
          } else {
            let entityType = req.path.split('/')[1] || 'unknown';
            if (entityType === 'auth') {
              entityType = req.path.split('/')[2] || 'auth';
            }
            let action = req.method;
            
            // Do not block response, fire and forget
            logGlobalAudit({
              actorUserId: req.user.id,
              actorName: req.user.name,
              actorRole: req.user.role,
              action,
              entityType,
              details: { path: req.path, method: req.method },
              ipAddress: getRequestIp(req)
            }).catch(err => console.error('[Audit] Failed to log:', err));
          }
        } catch (e) {
          // If response body is not JSON, we still log it.
          let entityType = req.path.split('/')[1] || 'unknown';
          let action = req.method;
          logGlobalAudit({
            actorUserId: req.user.id,
            actorName: req.user.name,
            actorRole: req.user.role,
            action,
            entityType,
            details: { path: req.path, method: req.method },
            ipAddress: getRequestIp(req)
          }).catch(err => console.error('[Audit] Failed to log:', err));
        }
      }
      originalSend.call(this, body);
    };
  }
  next();
});

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
    res.json({ success: true, sessions: rows.map(rowToAuthSessionDto), error: null });
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
      user.id,
    ]);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

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
    res.status(500).json({ success: false, error: error.message });
  }
});

};
