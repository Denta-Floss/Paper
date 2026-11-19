'use strict';

const F = require('../../kernel/fields');

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
      input: { fields: { id: F.id, query: F.none, data: F.obj({ barcodes: F.list(F.obj({ challanItemId: F.int, challan_item_id: F.int, parentCode: F.text, parent_code: F.text, childCode: F.text, child_code: F.text, weight: F.num })) }) } },
      run: (input, ctx) => runMoved(core.addPieceBarcodes, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.listForOrder': {
      permission: 'orders.read',
      summary: 'The delivery challans raised against an order line.',
      input: { fields: { orderId: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.listForOrder, ctx, { params: { orderId: input.orderId }, query: input.query || {}, body: input.data }),
    },
    'challans.assets.uploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a challan photo.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ uploadType: F.text, entityType: F.text, entityId: F.int, fileName: F.text, contentType: F.text, sizeBytes: F.int, sha256: F.text, isPrimary: F.flag, documentTitle: F.text, thumbnail: F.text, width: F.int, height: F.int }) } },
      run: (input, ctx) => runMoved(core.assetUploadIntent, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.assets.uploadComplete': {
      permission: 'challans.create',
      summary: 'Say a challan photo arrived.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ entityId: F.int, uploadSessionId: F.text, objectKey: F.text }) } },
      run: (input, ctx) => runMoved(core.assetUploadComplete, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.list': {
      permission: 'challans.read',
      summary: 'Challans, paged and filtered.',
      input: { fields: { query: F.obj({ type: F.text, status: F.text, search: F.text, dateFrom: F.text, date_from: F.text, dateTo: F.text, date_to: F.text, orderId: F.int, order_id: F.int, vendorId: F.int, vendor_id: F.int, itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, mine: F.text, createdBy: F.int, created_by: F.int }), data: F.none } },
      run: (input, ctx) => runMoved(core.handleListChallans, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.create': {
      permission: 'challans.create',
      summary: 'Create a draft challan.',
      input: { fields: { query: F.none, data: F.obj({ id: F.int, challanNo: F.text, challan_no: F.text, challanType: F.text, challan_type: F.text, type: F.text, challanPurpose: F.text, challan_purpose: F.text, purpose: F.text, customerName: F.text, customer_name: F.text, customerGstin: F.text, customer_gstin: F.text, date: F.text, maintainStocks: F.flag, maintain_stocks: F.flag, materialOwnerClientId: F.int, material_owner_client_id: F.int, materialOwnerClientName: F.text, material_owner_client_name: F.text, materialOwnerGstin: F.text, material_owner_gstin: F.text, internalPurpose: F.text, internal_purpose: F.text, internalSubtype: F.text, internal_subtype: F.text, notes: F.text, location: F.text, orderId: F.int, orderNo: F.text, order_no: F.text, orderIds: F.list(F.int), poDate: F.text, po_date: F.text, poNumber: F.text, po_number: F.text, reportGroupCodes: F.list(F.text), report_group_codes: F.list(F.text), returnedSheetCodes: F.list(F.text), returned_sheet_codes: F.list(F.text), sourceReceptionChallanId: F.int, source_reception_challan_id: F.int, sourceReference: F.text, source_reference: F.text, pieceBarcodes: F.list(), piece_barcodes: F.list(), genericAssets: F.list(F.none), items: F.list(F.obj({ itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, variationPathLabel: F.text, variation_path_label: F.text, variationPathNodeIds: F.list(), variation_path_node_ids: F.list(), variation_path_node_ids_json: F.text, customVariationValues: F.none, custom_variation_values: F.none, custom_variation_values_json: F.text, hsnCode: F.text, hsn_code: F.text, lineNo: F.int, line_no: F.int, lineNote: F.text, line_note: F.text, note: F.text, materialBarcode: F.text, material_barcode: F.text, orderItemId: F.int, order_item_id: F.int, particulars: F.text, productionRunId: F.int, production_run_id: F.int, quantityPcs: F.num, quantity_pcs: F.num, weight: F.num })) }) } },
      run: (input, ctx) => runMoved(core.handleCreateChallan, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.get': {
      permission: 'challans.read',
      summary: 'One challan.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.handleGetChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.update': {
      permission: 'challans.update',
      summary: 'Edit a draft challan.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ id: F.int, challanNo: F.text, challan_no: F.text, challanType: F.text, challan_type: F.text, type: F.text, challanPurpose: F.text, challan_purpose: F.text, purpose: F.text, customerName: F.text, customer_name: F.text, customerGstin: F.text, customer_gstin: F.text, date: F.text, maintainStocks: F.flag, maintain_stocks: F.flag, materialOwnerClientId: F.int, material_owner_client_id: F.int, materialOwnerClientName: F.text, material_owner_client_name: F.text, materialOwnerGstin: F.text, material_owner_gstin: F.text, internalPurpose: F.text, internal_purpose: F.text, internalSubtype: F.text, internal_subtype: F.text, notes: F.text, location: F.text, orderId: F.int, orderNo: F.text, order_no: F.text, orderIds: F.list(F.int), poDate: F.text, po_date: F.text, poNumber: F.text, po_number: F.text, reportGroupCodes: F.list(F.text), report_group_codes: F.list(F.text), returnedSheetCodes: F.list(F.text), returned_sheet_codes: F.list(F.text), sourceReceptionChallanId: F.int, source_reception_challan_id: F.int, sourceReference: F.text, source_reference: F.text, pieceBarcodes: F.list(), piece_barcodes: F.list(), genericAssets: F.list(F.none), items: F.list(F.obj({ itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, variationPathLabel: F.text, variation_path_label: F.text, variationPathNodeIds: F.list(), variation_path_node_ids: F.list(), variation_path_node_ids_json: F.text, customVariationValues: F.none, custom_variation_values: F.none, custom_variation_values_json: F.text, hsnCode: F.text, hsn_code: F.text, lineNo: F.int, line_no: F.int, lineNote: F.text, line_note: F.text, note: F.text, materialBarcode: F.text, material_barcode: F.text, orderItemId: F.int, order_item_id: F.int, particulars: F.text, productionRunId: F.int, production_run_id: F.int, quantityPcs: F.num, quantity_pcs: F.num, weight: F.num })) }) } },
      run: (input, ctx) => runMoved(core.handleUpdateChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.issue': {
      permission: 'challans.create',
      summary: 'Issue a challan: its lines move stock, in one transaction.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.handleIssueChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.reconcile': {
      permission: 'challans.reconcile',
      summary: 'Settle an internal-use challan into stock, scrap and finished goods, and complete its order.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ lines: F.list(F.obj({ challanItemId: F.int, id: F.int, buckets: F.obj({ scrap: F.num, leftover: F.num, lost: F.num, rejection: F.num, finishedGoods: F.num }) })) }) } },
      run: (input, ctx) => runMoved(core.handleReconcileChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.cancel': {
      permission: 'challans.create',
      summary: 'Cancel a challan and undo its stock; a partly used reception becomes a vendor return instead.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ action: F.text }) } },
      run: (input, ctx) => runMoved(core.handleCancelChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.cancelOptions': {
      permission: 'challans.read',
      summary: 'What cancelling a challan would do.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.handleGetCancelOptions, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.setReportGroups': {
      permission: 'challans.update',
      summary: 'Set which report groups a challan counts under.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ reportGroupCodes: F.list(F.text), report_group_codes: F.list(F.text) }) } },
      run: (input, ctx) => runMoved(core.handleUpdateChallanReportGroups, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.print': {
      permission: 'challans.create',
      summary: 'Record that a challan was printed.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.handlePrintChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.delete': {
      permission: 'challans.delete',
      summary: 'Delete a draft challan.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(core.handleDeleteChallan, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.list': {
      permission: 'challans.read',
      summary: 'The print templates.',
      input: { fields: { query: F.obj({ partyType: F.text, party_type: F.text, partyId: F.int, party_id: F.int, challanType: F.text, challan_type: F.text, activeOnly: F.text, active_only: F.text }), data: F.none } },
      run: (input, ctx) => runMoved(template.listTemplates, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.scans': {
      permission: 'challans.read',
      summary: 'The scanned stationery a template can be built on.',
      input: { fields: { query: F.obj({ limit: F.int }), data: F.none } },
      run: (input, ctx) => runMoved(template.listTemplateScans, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrint': {
      permission: 'challans.read',
      summary: 'A test print of a template, as a PDF.',
      input: { fields: { query: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mode: F.text }), data: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mappings: F.list(), mode: F.text }) } },
      run: (input, ctx) => runMoved(template.testPrintGet, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.get': {
      permission: 'challans.read',
      summary: 'One print template.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(template.getTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.create': {
      permission: 'challans.create',
      summary: 'Add a print template.',
      input: { fields: { query: F.none, data: F.obj({ name: F.text, partyType: F.text, party_type: F.text, partyId: F.int, party_id: F.int, challanType: F.text, challan_type: F.text, paperSize: F.text, paper_size: F.text, stockSize: F.text, stock_size: F.text, nUpLayout: F.none, n_up_layout: F.none, mappings: F.list(), backgroundObjectKey: F.text, background_object_key: F.text, canvasWidth: F.num, canvas_width: F.num, canvasHeight: F.num, canvas_height: F.num, globalOffsetXmm: F.num, global_offset_x_mm: F.num, globalOffsetYmm: F.num, global_offset_y_mm: F.num, rotationDegrees: F.num, rotation_degrees: F.num, isActive: F.flag, is_active: F.flag }) } },
      run: (input, ctx) => runMoved(template.createTemplate, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.update': {
      permission: 'challans.update',
      summary: 'Change a print template.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ name: F.text, partyType: F.text, party_type: F.text, partyId: F.int, party_id: F.int, challanType: F.text, challan_type: F.text, paperSize: F.text, paper_size: F.text, stockSize: F.text, stock_size: F.text, nUpLayout: F.none, n_up_layout: F.none, mappings: F.list(), backgroundObjectKey: F.text, background_object_key: F.text, canvasWidth: F.num, canvas_width: F.num, canvasHeight: F.num, canvas_height: F.num, globalOffsetXmm: F.num, global_offset_x_mm: F.num, globalOffsetYmm: F.num, global_offset_y_mm: F.num, rotationDegrees: F.num, rotation_degrees: F.num, isActive: F.flag, is_active: F.flag }) } },
      run: (input, ctx) => runMoved(template.updateTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.delete': {
      permission: 'challans.delete',
      summary: 'Remove a print template.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(template.deleteTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.templates.uploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a template scan.',
      input: { fields: { query: F.none, data: F.obj({ fileName: F.text, contentType: F.text, sizeBytes: F.int, sha256: F.text, uploadType: F.text }) } },
      run: (input, ctx) => runMoved(template.templateUploadIntent, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.uploadComplete': {
      permission: 'challans.create',
      summary: 'Say a template scan arrived.',
      input: { fields: { query: F.none, data: F.obj({ uploadSessionId: F.text, objectKey: F.text }) } },
      run: (input, ctx) => runMoved(template.templateUploadComplete, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.stampUploadIntent': {
      permission: 'challans.create',
      summary: 'Ask for somewhere to upload a stamp.',
      input: { fields: { query: F.none, data: F.obj({ fileName: F.text, contentType: F.text, sizeBytes: F.int, sha256: F.text, uploadType: F.text }) } },
      run: (input, ctx) => runMoved(template.stampUploadIntent, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.stampUploadComplete': {
      permission: 'challans.create',
      summary: 'Say a stamp arrived.',
      input: { fields: { query: F.none, data: F.obj({ uploadSessionId: F.text, objectKey: F.text }) } },
      run: (input, ctx) => runMoved(template.stampUploadComplete, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrintPosted': {
      permission: 'challans.create',
      summary: 'A test print of a template sent in the request, as a PDF.',
      input: { fields: { query: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mode: F.text }), data: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mappings: F.list(), mode: F.text }) } },
      run: (input, ctx) => runMoved(template.testPrintPost, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.templates.testPrintFor': {
      permission: 'challans.read',
      summary: 'A test print of a stored template, as a PDF.',
      input: { fields: { id: F.id, query: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mode: F.text }), data: F.obj({ templateId: F.int, template_id: F.int, itemCount: F.int, item_count: F.int, mappings: F.list(), mode: F.text }) } },
      run: (input, ctx) => runMoved(template.testPrintForTemplate, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.printPreview': {
      permission: 'challans.read',
      summary: 'A challan as its template would print it, as a PDF.',
      input: { fields: { id: F.id, query: F.obj({ templateId: F.int, template_id: F.int, mode: F.text }), data: F.none } },
      run: (input, ctx) => runMoved(template.printTemplatePreview, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.list': {
      permission: 'challans.read',
      summary: 'Invoices.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(invoice.listInvoices, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.invoices.get': {
      permission: 'challans.read',
      summary: 'One invoice, with its lines.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(invoice.getInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.pdf': {
      permission: 'challans.read',
      summary: 'An invoice as a PDF.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(invoice.invoicePdf, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.setStatus': {
      permission: 'challans.update',
      summary: 'Move an invoice along its status.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ status: F.text }) } },
      run: (input, ctx) => runMoved(invoice.setInvoiceStatus, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.update': {
      permission: 'challans.update',
      summary: 'Replace an invoice’s lines and recompute its totals.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ invoiceNo: F.text, invoice_no: F.text, invoiceDate: F.text, invoice_date: F.text, clientId: F.int, client_id: F.int, clientName: F.text, client_name: F.text, gstin: F.text, customerGstin: F.text, customer_gstin: F.text, status: F.text, lines: F.list(F.obj({ quantity: F.num, qty: F.num, unitPrice: F.num, unit_price: F.num, cgstRate: F.num, cgst_rate: F.num, sgstRate: F.num, sgst_rate: F.num, cgstAmount: F.num, sgstAmount: F.num, taxableValue: F.num, orderId: F.int, order_id: F.int, challanId: F.int, challan_id: F.int, challanItemId: F.int, challan_item_id: F.int, itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, itemName: F.text, item_name: F.text, hsnCode: F.text, hsn_code: F.text })) }) } },
      run: (input, ctx) => runMoved(invoice.updateInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.delete': {
      permission: 'challans.delete',
      summary: 'Delete an invoice.',
      input: { fields: { id: F.id, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(invoice.deleteInvoice, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
    'challans.invoices.create': {
      permission: 'challans.create',
      summary: 'Raise an invoice from challans.',
      input: { fields: { query: F.none, data: F.obj({ invoiceNo: F.text, invoice_no: F.text, invoiceDate: F.text, invoice_date: F.text, clientId: F.int, client_id: F.int, clientName: F.text, client_name: F.text, gstin: F.text, customerGstin: F.text, customer_gstin: F.text, status: F.text, lines: F.list(F.obj({ quantity: F.num, qty: F.num, unitPrice: F.num, unit_price: F.num, cgstRate: F.num, cgst_rate: F.num, sgstRate: F.num, sgst_rate: F.num, cgstAmount: F.num, sgstAmount: F.num, taxableValue: F.num, orderId: F.int, order_id: F.int, challanId: F.int, challan_id: F.int, challanItemId: F.int, challan_item_id: F.int, itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, itemName: F.text, item_name: F.text, hsnCode: F.text, hsn_code: F.text })) }) } },
      run: (input, ctx) => runMoved(invoice.createInvoice, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.reconciliation': {
      permission: 'challans.read',
      summary: 'The reconciliation report: received against delivered, with scrap.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(report.reconciliationReport, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.conversionOverrides': {
      permission: 'challans.read',
      summary: 'The unit conversions the report uses in place of the defaults.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(report.conversionOverrides, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.setConversionOverrides': {
      permission: 'challans.update',
      summary: 'Set those conversions.',
      input: { fields: { query: F.none, data: F.obj({ itemId: F.int, item_id: F.int, variationLeafNodeId: F.int, variation_leaf_node_id: F.int, fromUnit: F.text, from_unit: F.text, toUnitLabel: F.text, to_unit_label: F.text, conversionRatio: F.num, conversion_ratio: F.num }) } },
      run: (input, ctx) => runMoved(report.setConversionOverrides, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.wasteAudit': {
      permission: 'challans.read',
      summary: 'Where material went that was not delivered.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(report.wasteAudit, ctx, { query: input.query || {}, body: input.data }),
    },
    'challans.reports.orderReconciliation': {
      permission: 'orders.read',
      summary: 'One order’s reconciliation.',
      input: { fields: { orderNo: F.key, query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(report.orderReconciliation, ctx, { params: { orderNo: input.orderNo }, query: input.query || {}, body: input.data }),
    },
    'challans.reports.clientStatement': {
      permission: 'challans.create',
      summary: 'A client’s statement over a period.',
      input: { fields: { query: F.none, data: F.obj({ challanIds: F.list(F.int), challan_ids: F.list(F.int), receptionChallanIds: F.list(F.int), reception_challan_ids: F.list(F.int), reportGroupCode: F.text, report_group_code: F.text, date: F.text, weight: F.num, challanNo: F.text }) } },
      run: (input, ctx) => runMoved(report.clientStatement, ctx, { query: input.query || {}, body: input.data }),
    },

    // --- internal: asked by other modules ----------------------------------

    'challans.templates.remove': {
      internal: true,
      summary: 'Delete a print template: an approved delete request.',
      input: { fields: { id: { type: 'any', required: true } } },
      run: async (input) => ({ ok: true, value: await removeTemplate(input.id) }),
    },

    'challans.items.usageRows': {
      internal: true,
      summary: 'The challan lines that carry an item, with their challan, newest first, at most 50.',
      input: { fields: { itemId: F.int } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({
        ok: true,
        rows: await all(
          `SELECT dci.id, dci.challan_id, dc.challan_no, dc.customer_name, dc.date, dc.status
             FROM delivery_challan_items dci
             JOIN delivery_challans dc ON dci.challan_id = dc.id
            WHERE dci.item_id = ? ORDER BY dc.date DESC LIMIT 50`,
          [input.itemId],
        ),
      }),
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

    'challans.deliveries.byOrderLines': {
      internal: true,
      summary: 'What issued delivery challans delivered against each order line: one row per line and challan, with the pieces and weight summed. For the fulfilment report.',
      input: { fields: {} },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async () => ({
        ok: true,
        rows: await all(`
          SELECT
            dci.order_item_id AS order_item_id,
            dc.id             AS challan_id,
            dc.challan_no     AS challan_no,
            dc.date           AS challan_date,
            dc.status         AS challan_status,
            dc.customer_name  AS client_name,
            SUM(dci.quantity_pcs) AS quantity_pcs,
            SUM(dci.weight)       AS weight
          FROM delivery_challan_items dci
          JOIN delivery_challans dc ON dc.id = dci.challan_id
          WHERE dci.order_item_id IS NOT NULL
            AND dci.order_item_id > 0
            AND dc.type = 'delivery'
            AND dc.status = 'issued'
          GROUP BY dci.order_item_id, dc.id
          ORDER BY dci.order_item_id ASC, dc.date ASC, dc.id ASC
        `),
      }),
    },

    'challans.sheets.provenance': {
      internal: true,
      summary: 'Where a vendor sheet came from: its piece codes and weight, and the reception challan and vendor it arrived on; or nothing.',
      input: { fields: { code: F.text } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => {
        const rows = await all(`
          SELECT pb.parent_code, pb.child_code, pb.weight,
                 c.vendor_id, c.vendor_name, c.challan_no AS reception_challan_no, c.date AS reception_date
          FROM piece_barcodes pb
          JOIN delivery_challan_items ci ON pb.challan_item_id = ci.id
          JOIN delivery_challans c ON ci.challan_id = c.id
          WHERE pb.parent_code = ? OR pb.child_code = ?
        `, [input.code, input.code]);
        return { ok: true, row: rows[0] || null };
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
