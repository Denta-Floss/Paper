'use strict';

// ---------------------------------------------------------------------------
// Kernel Introspection routes.
//
// Health, guard-alerts, territory, reconcile.
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { computeTerritory } = require('../territory');
const { reconcile } = require('../reconcile');

module.exports = function registerIntrospectionKernelRoutes(ctx) {
  const {
    app,
    requireAuth,
    requireRoles,
    all,
    get,
    isDbReady,
    getPort,
    isProduction,
    getDbPath,
    getDbInitError,
  } = ctx;

app.get('/health', (_req, res) => {
  const dbReady = isDbReady ? isDbReady() : true;
  const port = getPort ? getPort() : 3000;
  const isProd = isProduction ? isProduction() : false;
  const dbPath = getDbPath ? getDbPath() : null;
  const dbInitError = getDbInitError ? getDbInitError() : null;

  res.json({
    success: true,
    status: dbReady ? 'ok' : 'starting',
    port,
    dbPath: isProd ? null : dbPath,
    dbReady,
    dbInitError: dbInitError?.message ?? null,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/kernel/guard-alerts', requireAuth, requireRoles('super_admin', 'admin'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await all(
      "SELECT id, entity_id, actor_name, actor_role, details_json, created_at FROM entity_activity_log WHERE entity_type = 'kernel_guard' ORDER BY id DESC LIMIT ?",
      [limit],
    );
    const enforcing = typeof ctx.getContractEnforce === 'function'
      ? ctx.getContractEnforce()
      : (typeof ctx.CONTRACT_ENFORCE !== 'undefined' ? ctx.CONTRACT_ENFORCE : process.env.PAPER_CONTRACT_ENFORCE === '1');
    res.json({
      success: true,
      enforcing,
      alerts: rows.map((row) => ({
        id: row.id,
        route: row.entity_id,
        actorName: row.actor_name,
        actorRole: row.actor_role,
        details: typeof row.details_json === 'string' ? JSON.parse(row.details_json || '{}') : (row.details_json || {}),
        createdAt: row.created_at,
      })),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, alerts: [], error: error.message });
  }
});

app.get("/api/kernel/territory", requireAuth, requireRoles('super_admin', 'admin'), async (req, res) => {
  try {
    const itemsPorts = ctx.itemsPorts;
    const challansPorts = ctx.challansPorts;
    const result = await computeTerritory({
      app,
      allRows: all,
      runtime: {
        items: {
          portCalls: itemsPorts ? itemsPorts.stats() : {}
        },
        challans: {
          portCalls: challansPorts ? challansPorts.stats() : {}
        }
      }
    });
    res.json({ success: true, territory: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/kernel/reconcile', requireAuth, requireRoles('super_admin', 'admin'), async (req, res) => {
  try {
    const migrationsDir = path.join(__dirname, '../../migrations');
    const modulesDir = path.join(__dirname, '../../modules');
    const migrationFiles = fs.existsSync(migrationsDir)
      ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') || f.endsWith('.js')).sort()
      : [];
    const moduleDirs = fs.existsSync(modulesDir)
      ? fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      : [];
    const report = await reconcile({
      app,
      allRows: all,
      getRow: get,
      migrationFiles,
      moduleDirs,
      clientId: String(req.query.clientId || 'default'),
    });
    res.json({ success: true, reconcile: report, error: null });
  } catch (error) {
    res.status(500).json({ success: false, reconcile: null, error: error.message });
  }
});

};
