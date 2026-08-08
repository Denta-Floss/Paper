'use strict';

// ---------------------------------------------------------------------------
// Kernel Admin routes.
//
// Reset demo data, factory reset, clear data, reseed data.
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

module.exports = function registerAdminKernelRoutes(ctx) {
  const {
    app,
    requireRoles,
    requirePermission,
    resetAndSeedDemoData,
    factoryResetData,
    clearAllData,
    reseedDemoData,
  } = ctx;

app.post(
  '/api/admin/reset-demo-data',
  requireRoles('super_admin', 'admin'),
  requirePermission('config.write'),
  async (req, res) => {
    try {
      const scenarioId = req.body?.scenarioId || 'default';
      await resetAndSeedDemoData(scenarioId);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

console.log('Registering /api/admin/factory-reset route...');
app.post(
  '/api/admin/factory-reset',
  requireRoles('super_admin'),
  async (_req, res) => {
    try {
      await factoryResetData();
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

console.log('Registering /api/admin/clear-data route...');
app.post(
  '/api/admin/clear-data',
  requireRoles('super_admin', 'admin'),
  requirePermission('config.write'),
  async (_req, res) => {
    try {
      await clearAllData();
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

app.post(
  '/api/admin/reseed-data',
  requireRoles('super_admin', 'admin'),
  requirePermission('config.write'),
  async (req, res) => {
    try {
      const scenarioId = req.body?.scenarioId || 'default';
      await reseedDemoData(scenarioId);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

};
