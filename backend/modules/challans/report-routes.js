'use strict';

// ---------------------------------------------------------------------------
// Challan reports over HTTP.
//
//   GET   /api/reconciliation/report                 issued against billed
//   GET   /api/reconciliation/conversion-overrides   the ratios in force
//   PATCH /api/reconciliation/conversion-overrides   set one
//   GET   /api/reconciliation/waste-audit            what the report wrote off
//   POST  /api/reports/client-statement              a client's statement
//   GET   /api/orders/:orderNo/reconciliation        one order, end to end
//
// Two of these are not plain reads, and stay that way: the report GET rewrites
// the waste audit, and the statement POST marks challans as reported.
// `reconciliation` and `reports` map to challans in the central gate; the
// order-path route is gated as orders, by its first path segment. Handlers are
// the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------

module.exports = function registerChallanReportRoutes(ctx) {
  const {
    reportService,
    app,
    requirePermission,
  } = ctx;

  app.get('/api/reconciliation/report', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, data: await reportService.buildReconciliationReport(), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/reconciliation/conversion-overrides', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, data: await reportService.listConversionOverrides(), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  });

  app.patch('/api/reconciliation/conversion-overrides', requirePermission('config.write'), async (req, res) => {
    try {
      res.json({ success: true, data: await reportService.saveConversionOverride(req.body || {}), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/reconciliation/waste-audit', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, data: await reportService.listWasteAuditRows(), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:orderNo/reconciliation', requirePermission('config.read'), async (req, res) => {
    try {
      const data = await reportService.buildOrderReconciliation({ orderNo: req.params.orderNo });
      res.json({ success: true, data, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        error: error.message,
      });
    }
  });

  app.post('/api/reports/client-statement', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, data: await reportService.buildClientStatementReport(req.body || {}), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });
};
