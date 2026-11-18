'use strict';

// ---------------------------------------------------------------------------
// The reconciliation report, conversion overrides, the waste audit, an order’s reconciliation and the client statement.
//
// These were the bodies of the handlers in report-routes.js, here statement for
// statement. Instead of writing a response each returns answer(status, body)
// (or answerFile for a PDF): the same status, the same body. A function takes a
// plain `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes them at the kernel desk; ./report-routes.js asks the
// desk and sends the result back as the answer it was.
// ---------------------------------------------------------------------------

const { answer, answerFile } = require('../../kernel/desk-kit');

function createChallanReportWork({
  reportService,
}) {

  async function reconciliationReport(req) {
    try {
      return answer(200, { success: true, data: await reportService.buildReconciliationReport(), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function conversionOverrides(req) {
    try {
      return answer(200, { success: true, data: await reportService.listConversionOverrides(), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  async function setConversionOverrides(req) {
    try {
      return answer(200, { success: true, data: await reportService.saveConversionOverride(req.body || {}), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function wasteAudit(req) {
    try {
      return answer(200, { success: true, data: await reportService.listWasteAuditRows(), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  async function orderReconciliation(req) {
    try {
      const data = await reportService.buildOrderReconciliation({ orderNo: req.params.orderNo });
      return answer(200, { success: true, data, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        error: error.message,
      });
    }
  }

  async function clientStatement(req) {
    try {
      return answer(200, { success: true, data: await reportService.buildClientStatementReport(req.body || {}), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  return {
    reconciliationReport,
    conversionOverrides,
    setConversionOverrides,
    wasteAudit,
    orderReconciliation,
    clientStatement,
  };
}

module.exports = { createChallanReportWork };
