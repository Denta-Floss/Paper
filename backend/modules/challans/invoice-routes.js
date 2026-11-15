'use strict';

const barcodes = require('../../kernel/barcodes');

// ---------------------------------------------------------------------------
// Invoices over HTTP.
//
//   GET    /api/invoices              the list
//   GET    /api/invoices/:id          one, with its lines
//   GET    /api/invoices/:id/pdf      the printable invoice
//   POST   /api/invoices              raise one (records INVOICED in the custody
//                                     ledger once per distinct challan billed)
//   PATCH  /api/invoices/:id/status   move its status
//   PUT    /api/invoices/:id          edit it
//   DELETE /api/invoices/:id          remove it
//
// `invoices` is a first path segment the central CRUD gate maps to challans.
// Handlers are the ones that lived in server.js, moved whole.
//
// KNOWN BUG, kept until its own fix: PUT /api/invoices/:id always fails with
// "prepare is not defined"; the edit rolls back and the invoice is unchanged.
// ---------------------------------------------------------------------------

module.exports = function registerInvoiceRoutes(ctx) {
  const {
    invoiceService,
    app,
    get,
    all,
    run,
    requirePermission,
    actorFromRequest,
    recordLedgerEvent,
  } = ctx;

  app.get('/api/invoices', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, data: await invoiceService.listInvoices(), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/invoices/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const invoice = await invoiceService.getInvoiceDtoById(Number(req.params.id));
      if (!invoice) {
        res.status(404).json({
          success: false,
          data: null,
          message: 'Invoice not found.',
          error: 'Invoice not found.',
        });
        return;
      }
      res.json({ success: true, data: invoice, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/invoices/:id/pdf', requirePermission('config.read'), async (req, res) => {
    try {
      const invoiceId = Number(req.params.id);
      if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid invoice ID is required.',
          error: 'Valid invoice ID is required.'
        });
      }
      const buffer = await invoiceService.generateInvoicePdf(invoiceId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="Invoice-${invoiceId}.pdf"`
      );
      res.send(buffer);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.patch('/api/invoices/:id/status', requirePermission('config.write'), async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!status) {
        return res.status(400).json({
          success: false,
          message: 'Status is required.',
          error: 'Status is required.'
        });
      }
      const normalizedStatus = String(status).trim().toLowerCase();
      if (!['issued', 'paid'].includes(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invoice status must be 'issued' or 'paid'.",
          error: "Invoice status must be 'issued' or 'paid'."
        });
      }
      const invoiceId = Number(req.params.id);
      if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Valid invoice id is required.',
          error: 'Valid invoice id is required.'
        });
      }
      await run(
        'UPDATE invoice_headers SET status = ?, updated_at = ? WHERE id = ?',
        [normalizedStatus, new Date().toISOString(), invoiceId]
      );
      const updatedInvoice = await invoiceService.getInvoiceDtoById(invoiceId);
      if (!updatedInvoice) {
        return res.status(404).json({
          success: false,
          message: 'Invoice not found.',
          error: 'Invoice not found.'
        });
      }
      res.json({ success: true, data: updatedInvoice, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.put('/api/invoices/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const input = req.body || {};
      const linesInput = Array.isArray(input.lines) ? input.lines : [];
      if (linesInput.length === 0) {
        throw new Error('Add at least one invoice line.');
      }
      const invoiceNo = String(input.invoiceNo ?? input.invoice_no ?? '').trim();
      if (invoiceNo) {
        const duplicate = await get('SELECT id FROM invoice_headers WHERE LOWER(TRIM(invoice_no)) = LOWER(TRIM(?)) AND id != ?', [invoiceNo, id]);
        if (duplicate) throw new Error(`Invoice number [${invoiceNo}] is already in use.`);
      }

      const now = new Date().toISOString();
      const invoiceDate = input.invoiceDate ?? input.invoice_date ?? now;

      let totalQuantity = 0, taxableValue = 0, cgstAmount = 0, sgstAmount = 0;
      const normalizedLines = [];
      for (const rawLine of linesInput) {
        const qty = Number(rawLine.quantity ?? rawLine.qty ?? 0) || 0;
        const unitP = Number(rawLine.unitPrice ?? rawLine.unit_price ?? 0) || 0;
        const cRate = Number(rawLine.cgstRate ?? rawLine.cgst_rate ?? 0) || 0;
        const sRate = Number(rawLine.sgstRate ?? rawLine.sgst_rate ?? 0) || 0;
        const taxVal = qty * unitP;
        const cgst = taxVal * cRate / 100;
        const sgst = taxVal * sRate / 100;

        totalQuantity += qty;
        taxableValue += taxVal;
        cgstAmount += cgst;
        sgstAmount += sgst;

        normalizedLines.push({
          orderId: Number(rawLine.orderId ?? rawLine.order_id ?? 0) || null,
          challanId: Number(rawLine.challanId ?? rawLine.challan_id ?? 0) || null,
          challanItemId: Number(rawLine.challanItemId ?? rawLine.challan_item_id ?? 0) || null,
          itemId: Number(rawLine.itemId ?? rawLine.item_id ?? 0) || null,
          variationLeafNodeId: Number(rawLine.variationLeafNodeId ?? rawLine.variation_leaf_node_id ?? 0) || 0,
          itemName: String(rawLine.itemName ?? rawLine.item_name ?? '').trim(),
          hsnCode: String(rawLine.hsnCode ?? rawLine.hsn_code ?? '').trim(),
          quantity: qty, unitPrice: unitP, taxableValue: taxVal, cgstRate: cRate, sgstRate: sRate, cgstAmount: cgst, sgstAmount: sgst
        });
      }

      await run('BEGIN TRANSACTION');
      try {
        await run(
          `UPDATE invoice_headers SET 
            client_id = ?, client_name = ?, gstin = ?, status = ?, invoice_date = ?,
            total_quantity = ?, taxable_value = ?, cgst_amount = ?, sgst_amount = ?, total_amount = ?, updated_at = ?
           WHERE id = ?`,
          [
            Number(input.clientId ?? input.client_id ?? 0) || null,
            String(input.clientName ?? input.client_name ?? '').trim(),
            String(input.gstin ?? input.customerGstin ?? input.customer_gstin ?? '').trim(),
            String(input.status || 'draft').trim() || 'draft',
            invoiceDate, totalQuantity, taxableValue, cgstAmount, sgstAmount, taxableValue + cgstAmount + sgstAmount, now, id
          ]
        );
        if (invoiceNo) {
          await run(`UPDATE invoice_headers SET invoice_no = ? WHERE id = ?`, [invoiceNo, id]);
        }

        await run('DELETE FROM invoice_lines WHERE invoice_id = ?', [id]);
      
        const insertLine = await prepare(`
          INSERT INTO invoice_lines (
            invoice_id, order_id, challan_id, challan_item_id, item_id, variation_leaf_node_id,
            item_name, hsn_code, quantity, unit_price, taxable_value, cgst_rate, sgst_rate, cgst_amount, sgst_amount, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const line of normalizedLines) {
          await insertLine.run([
            id, line.orderId, line.challanId, line.challanItemId, line.itemId, line.variationLeafNodeId,
            line.itemName, line.hsnCode, line.quantity, line.unitPrice, line.taxableValue, line.cgstRate, line.sgstRate, line.cgstAmount, line.sgstAmount, now, now
          ]);
        }
        await insertLine.finalize();
        await run('COMMIT');
      
        const invoice = await invoiceService.getInvoiceDtoById(id);
        res.json({ success: true, data: invoice, error: null });
      } catch (e) {
        await run('ROLLBACK');
        throw e;
      }
    } catch (error) {
      res.status(500).json({ success: false, data: null, error: error.message });
    }
  });

  app.delete('/api/invoices/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      await run('BEGIN TRANSACTION');
      await run('DELETE FROM invoice_lines WHERE invoice_id = ?', [id]);
      await run('DELETE FROM invoice_headers WHERE id = ?', [id]);
      await run('COMMIT');
      res.json({ success: true, error: null });
    } catch (error) {
      await run('ROLLBACK');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/invoices', requirePermission('config.write'), async (req, res) => {
    try {
      const invoice = await invoiceService.createInvoice(req.body || {});
      // Billing closes the challan's story. The subject is the delivery challan
      // rather than the invoice because an invoice is not a scannable thing —
      // there is no invoice barcode type, and inventing one would put a code on
      // something nobody ever holds. The challan is what a person has in hand
      // when they ask "was this billed?".
      //
      // Once per DISTINCT challan, not once per line: a five-line invoice against
      // one challan is one billing event, and the ledger cannot be de-duplicated
      // after the fact. Only creation emits — editing an invoice is not a second
      // billing.
      const billedChallans = await all(
        `
        SELECT DISTINCT dc.challan_no, dc.type
        FROM invoice_lines il
        JOIN delivery_challans dc ON dc.id = il.challan_id
        WHERE il.invoice_id = ? AND il.challan_id IS NOT NULL
        `,
        [invoice?.id || 0],
      );
      for (const challan of billedChallans) {
        const subject = barcodes.encode(
          String(challan.type || '').toLowerCase() === 'reception' ? 'RC' : 'DC',
          challan.challan_no,
        );
        if (!subject) continue;
        await recordLedgerEvent({
          subjectBarcode: subject,
          eventType: 'INVOICED',
          actorName: actorFromRequest(req)?.name || 'Office',
          metrics: {
            invoiceNo: invoice?.invoiceNo || '',
            invoiceId: invoice?.id || null,
            clientId: invoice?.clientId || null,
          },
          notes: invoice?.invoiceNo ? `Invoice ${invoice.invoiceNo}` : '',
        });
      }
      res.status(201).json({ success: true, data: invoice, error: null });
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
