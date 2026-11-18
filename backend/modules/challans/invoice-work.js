'use strict';

// ---------------------------------------------------------------------------
// Invoices raised from challans: list, read, PDF, status, edit, delete, create.
//
// These were the bodies of the handlers in invoice-routes.js, here statement for
// statement. Instead of writing a response each returns answer(status, body)
// (or answerFile for a PDF): the same status, the same body. A function takes a
// plain `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes them at the kernel desk; ./invoice-routes.js asks the
// desk and sends the result back as the answer it was.
// ---------------------------------------------------------------------------

const barcodes = require('../../kernel/barcodes');
const { answer, answerFile } = require('../../kernel/desk-kit');

function createInvoiceWork({
  invoiceService,
  get,
  all,
  run,
  actorFromRequest,
  recordLedgerEvent,
}) {

  async function listInvoices(req) {
    try {
      return answer(200, { success: true, data: await invoiceService.listInvoices(), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  async function getInvoice(req) {
    try {
      const invoice = await invoiceService.getInvoiceDtoById(Number(req.params.id));
      if (!invoice) {
        return answer(404, {
          success: false,
          data: null,
          message: 'Invoice not found.',
          error: 'Invoice not found.',
        });
        return;
      }
      return answer(200, { success: true, data: invoice, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function invoicePdf(req) {
    try {
      const invoiceId = Number(req.params.id);
      if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
        return answer(400, {
          success: false,
          message: 'Valid invoice ID is required.',
          error: 'Valid invoice ID is required.'
        });
      }
      const buffer = await invoiceService.generateInvoicePdf(invoiceId);
      return answerFile('application/pdf', `inline; filename="Invoice-${invoiceId}.pdf"`, buffer);
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function setInvoiceStatus(req) {
    try {
      const { status } = req.body || {};
      if (!status) {
        return answer(400, {
          success: false,
          message: 'Status is required.',
          error: 'Status is required.'
        });
      }
      const normalizedStatus = String(status).trim().toLowerCase();
      if (!['issued', 'paid'].includes(normalizedStatus)) {
        return answer(400, {
          success: false,
          message: "Invoice status must be 'issued' or 'paid'.",
          error: "Invoice status must be 'issued' or 'paid'."
        });
      }
      const invoiceId = Number(req.params.id);
      if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
        return answer(400, {
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
        return answer(404, {
          success: false,
          message: 'Invoice not found.',
          error: 'Invoice not found.'
        });
      }
      return answer(200, { success: true, data: updatedInvoice, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function updateInvoice(req) {
    try {
      const id = Number(req.params.id);
      const input = req.body || {};
      const linesInput = Array.isArray(input.lines) ? input.lines : [];
      if (linesInput.length === 0) {
        throw new Error('Add at least one invoice line.');
      }
      // Now that an edit can succeed, an id that is not there must not: the
      // header update would touch nothing and the lines would be left orphaned.
      const existing = await get('SELECT id FROM invoice_headers WHERE id = ?', [id]);
      if (!existing) {
        return answer(404, { success: false, data: null, error: 'Invoice not found.' });
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
      
        // One statement per line through `run`, as createInvoice does. This used
        // to call a `prepare` helper that does not exist, so every edit failed.
        for (const line of normalizedLines) {
          await run(
            `
            INSERT INTO invoice_lines (
              invoice_id, order_id, challan_id, challan_item_id, item_id, variation_leaf_node_id,
              item_name, hsn_code, quantity, unit_price, taxable_value, cgst_rate, sgst_rate, cgst_amount, sgst_amount, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              id, line.orderId, line.challanId, line.challanItemId, line.itemId, line.variationLeafNodeId,
              line.itemName, line.hsnCode, line.quantity, line.unitPrice, line.taxableValue, line.cgstRate, line.sgstRate, line.cgstAmount, line.sgstAmount, now, now
            ],
          );
        }
        await run('COMMIT');
      
        const invoice = await invoiceService.getInvoiceDtoById(id);
        return answer(200, { success: true, data: invoice, error: null });
      } catch (e) {
        await run('ROLLBACK');
        throw e;
      }
    } catch (error) {
      return answer(500, { success: false, data: null, error: error.message });
    }
  }

  async function deleteInvoice(req) {
    try {
      const id = req.params.id;
      await run('BEGIN TRANSACTION');
      await run('DELETE FROM invoice_lines WHERE invoice_id = ?', [id]);
      await run('DELETE FROM invoice_headers WHERE id = ?', [id]);
      await run('COMMIT');
      return answer(200, { success: true, error: null });
    } catch (error) {
      await run('ROLLBACK');
      return answer(500, { success: false, error: error.message });
    }
  }

  async function createInvoice(req) {
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
      return answer(201, { success: true, data: invoice, error: null });
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
    listInvoices,
    getInvoice,
    invoicePdf,
    setInvoiceStatus,
    updateInvoice,
    deleteInvoice,
    createInvoice,
  };
}

module.exports = { createInvoiceWork };
