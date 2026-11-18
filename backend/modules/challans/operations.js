'use strict';

// ---------------------------------------------------------------------------
// Challans — what the module offers at the kernel desk.
//
//   offered to users
//     challans.list · .get · .create · .update · .delete · .listForOrder
//     challans.issue · .cancel · .cancelOptions · .reconcile · .print
//     challans.setReportGroups · .pieceBarcodes.add · .printPreview
//     challans.assets.uploadIntent · .uploadComplete
//     challans.templates.*      the print templates, their scans and stamps
//     challans.invoices.*       invoices raised from challans
//     challans.reports.*        reconciliation, waste audit, client statement
//
//   internal — asked by other modules
//     challans.rows.brief       a challan's number and type, for inventory
//     challans.stageNotes.* · .sheets.findByCode        for production
//     challans.vendorUsageCount(s) · .vendorPurchaseRows  for the vendor master
//     challans.numbersByIds · .customVariationValueRows  for inventory
//
// The second group is ./ports.js behind names, listed in ./asks.js. A module
// reaches them through ./client.js.
//
// WHO MAY ASK is what the central gate asks of each path, and the gate goes by
// the first path segment and the HTTP method. That gives some keys a reader
// would not guess, kept because changing them changes who gets in:
//   - issuing, cancelling, printing and adding piece barcodes are POSTs, so
//     they ask for `challans.create`; so do a posted test print and the
//     client statement;
//   - settling an in-use challan asks for `challans.reconcile`, the gate's
//     one special case;
//   - an order's challans and an order's reconciliation sit under
//     /api/orders, so they ask for `orders.read`.
//
// The work is in ./work.js, ./template-work.js, ./invoice-work.js and
// ./report-work.js: what the handlers did, returning the status and body they
// used to send (or a PDF). A request's path values are named, its query
// travels under `query` and its body under `data`; a challan's payload is
// large and is checked by the service.
//
// ---------------------------------------------------------------------------

const { runMoved, operationsFromAsks, joinOperations } = require('../../kernel/desk-kit');
const ASKS = require('./asks');

const loose = { type: 'any' };

module.exports = function challanOperations({ all, core, template, invoice, report, ports, removeTemplate }) {
  return joinOperations(
    operationsFromAsks('challans', ASKS, ports),
    userOperations({ all, core, template, invoice, report, removeTemplate }),
  );
};

function userOperations({ all, core, template, invoice, report, removeTemplate }) {
  return {
    'challans.pieceBarcodes.add': {
      permission: 'challans.create',
      summary: 'Record the per-piece barcodes of a challan line.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.addPieceBarcodes, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.listForOrder': {
      permission: 'orders.read',
      summary: 'The delivery challans raised against an order line.',
      input: { fields: { orderId: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.listForOrder, ctx, { params: { orderId: input.orderId }, query: input.query || {}, body: input.data }),
    },
    'challans.assets.uploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a challan photo.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.assetUploadIntent, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.assets.uploadComplete': {
      permission: 'challans.create',
      summary: 'Say a challan photo arrived.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.assetUploadComplete, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.list': {
      permission: 'challans.read',
      summary: 'Challans, paged and filtered.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleListChallans, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.create': {
      permission: 'challans.create',
      summary: 'Create a draft challan.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleCreateChallan, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.get': {
      permission: 'challans.read',
      summary: 'One challan.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleGetChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.update': {
      permission: 'challans.update',
      summary: 'Edit a draft challan.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleUpdateChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.issue': {
      permission: 'challans.create',
      summary: 'Issue a challan: its lines move stock, in one transaction.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleIssueChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.reconcile': {
      permission: 'challans.reconcile',
      summary: 'Settle an internal-use challan into stock, scrap and finished goods, and complete its order.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleReconcileChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.cancel': {
      permission: 'challans.create',
      summary: 'Cancel a challan and undo its stock; a partly used reception becomes a vendor return instead.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleCancelChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.cancelOptions': {
      permission: 'challans.read',
      summary: 'What cancelling a challan would do.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleGetCancelOptions, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.setReportGroups': {
      permission: 'challans.update',
      summary: 'Set which report groups a challan counts under.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleUpdateChallanReportGroups, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.print': {
      permission: 'challans.create',
      summary: 'Record that a challan was printed.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handlePrintChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.delete': {
      permission: 'challans.delete',
      summary: 'Delete a draft challan.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.handleDeleteChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.list': {
      permission: 'challans.read',
      summary: 'The print templates.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.listTemplates, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.scans': {
      permission: 'challans.read',
      summary: 'The scanned stationery a template can be built on.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.listTemplateScans, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrint': {
      permission: 'challans.read',
      summary: 'A test print of a template, as a PDF.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.testPrintGet, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.get': {
      permission: 'challans.read',
      summary: 'One print template.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.getTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.create': {
      permission: 'challans.create',
      summary: 'Add a print template.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.createTemplate, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.update': {
      permission: 'challans.update',
      summary: 'Change a print template.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.updateTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.delete': {
      permission: 'challans.delete',
      summary: 'Remove a print template.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.deleteTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.uploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a template scan.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.templateUploadIntent, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.uploadComplete': {
      permission: 'challans.create',
      summary: 'Say a template scan arrived.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.templateUploadComplete, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.stampUploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a stamp.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.stampUploadIntent, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.stampUploadComplete': {
      permission: 'challans.create',
      summary: 'Say a stamp arrived.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.stampUploadComplete, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrintPosted': {
      permission: 'challans.create',
      summary: 'A test print of a template sent in the request, as a PDF.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.testPrintPost, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrintFor': {
      permission: 'challans.read',
      summary: 'A test print of a stored template, as a PDF.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.testPrintForTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.printPreview': {
      permission: 'challans.read',
      summary: 'A challan as its template would print it, as a PDF.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(template.printTemplatePreview, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.list': {
      permission: 'challans.read',
      summary: 'Invoices.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.listInvoices, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.invoices.get': {
      permission: 'challans.read',
      summary: 'One invoice, with its lines.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.getInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.pdf': {
      permission: 'challans.read',
      summary: 'An invoice as a PDF.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.invoicePdf, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.setStatus': {
      permission: 'challans.update',
      summary: 'Move an invoice along its status.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.setInvoiceStatus, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.update': {
      permission: 'challans.update',
      summary: 'Replace an invoice’s lines and recompute its totals.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.updateInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.delete': {
      permission: 'challans.delete',
      summary: 'Delete an invoice.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.deleteInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.create': {
      permission: 'challans.create',
      summary: 'Raise an invoice from challans.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(invoice.createInvoice, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.reconciliation': {
      permission: 'challans.read',
      summary: 'The reconciliation report: received against delivered, with scrap.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.reconciliationReport, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.conversionOverrides': {
      permission: 'challans.read',
      summary: 'The unit conversions the report uses in place of the defaults.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.conversionOverrides, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.setConversionOverrides': {
      permission: 'challans.update',
      summary: 'Set those conversions.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.setConversionOverrides, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.wasteAudit': {
      permission: 'challans.read',
      summary: 'Where material went that was not delivered.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.wasteAudit, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.orderReconciliation': {
      permission: 'orders.read',
      summary: 'One order’s reconciliation.',
      input: { fields: { orderNo: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.orderReconciliation, ctx, { params: { orderNo: input.orderNo }, query: input.query || {}, body: input.data }),
    },
    'challans.reports.clientStatement': {
      permission: 'challans.create',
      summary: 'A client’s statement over a period.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(report.clientStatement, ctx, { query: input.query || {}, body: input.data }),
    },

    // --- internal: asked by other modules ----------------------------------

    'challans.templates.remove': {
      internal: true,
      summary: 'Delete a print template: an approved delete request.',
      input: { fields: { id: { type: 'any', required: true } } },
      run: async (input) => ({ ok: true, value: await removeTemplate(input.id) }),
    },

    'challans.items.lineCount': {
      internal: true,
      summary: 'How many challan lines name an item.',
      input: { fields: { itemId: { type: 'any', required: true } } },
      output: { fields: { count: { type: 'integer', required: true, min: 0 } } },
      run: async (input) => {
        const rows = await all('SELECT COUNT(*) AS count FROM delivery_challan_items WHERE item_id = ?', [input.itemId]);
        return { ok: true, count: Number(rows[0]?.count || 0) };
      },
    },

    'challans.rows.brief': {
      internal: true,
      summary: 'The number and type of these challans, as rows of id, challan_no and type.',
      input: { fields: { ids: { type: 'array', required: true } } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => {
        const ids = (input.ids || []).map(Number).filter((id) => Number.isInteger(id));
        if (!ids.length) return { ok: true, rows: [] };
        return {
          ok: true,
          rows: await all(
            `SELECT id, challan_no, type FROM delivery_challans WHERE id IN (${ids.map(() => '?').join(', ')})`,
            ids,
          ),
        };
      },
    },
  };
};
