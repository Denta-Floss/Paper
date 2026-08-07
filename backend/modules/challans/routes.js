'use strict';

// ---------------------------------------------------------------------------
// Challans module — HTTP routes.
//
// All 52 route registrations for challans territory (challans,
// delivery-challans, invoices, reconciliation, challan-templates, reports,
// templates) moved VERBATIM from server.js. No logic edits: a move and an edit
// never share a commit, so any regression can only be a wiring problem.
//
// The handler bodies are deliberately NOT re-indented. Several contain
// multi-line SQL template literals, and re-indenting would silently change the
// string contents. Byte-identical bodies beat tidy columns here.
//
// Registration ORDER is the original server.js order. Express matches in
// registration order and challans has real intra-module ordering constraints
// (e.g. GET /api/challan-templates/test-print must be registered before
// GET /api/challan-templates/:id, or the literal path is swallowed by the
// parameterised one).
//
// Domain logic (handleCreateChallan, the PDF engine, invoices, reconciliation)
// still lives in legacy server.js and arrives through ctx; it evacuates next,
// shrinking this list toward kernel facilities only.
// ---------------------------------------------------------------------------

module.exports = function registerChallansModuleRoutes(ctx) {
  const {
    app,
    all,
    buildClientStatementReport,
    buildReconciliationReport,
    completeAssetUpload,
    completeChallanTemplateUpload,
    createAssetUploadIntent,
    createChallanTemplateUploadIntent,
    createInvoice,
    deleteChallanTemplate,
    findActiveChallanTemplateForChallan,
    generateChallanTemplatePdf,
    generateInvoicePdf,
    get,
    getChallanTemplateRowById,
    getDeliveryChallanRowById,
    getInvoiceDtoById,
    handleCancelChallan,
    handleChallanTemplateTestPrint,
    handleCreateChallan,
    handleDeleteChallan,
    handleGetCancelOptions,
    handleGetChallan,
    handleIssueChallan,
    handleListChallans,
    handlePrintChallan,
    handleReconcileChallan,
    handleUpdateChallan,
    handleUpdateChallanReportGroups,
    listChallanTemplateScans,
    listChallanTemplates,
    listConversionOverrides,
    listInvoices,
    listWasteAuditRows,
    nowIso,
    parseBooleanEnv,
    parseJsonObject,
    requirePermission,
    rowToChallanTemplateDto,
    rowToDeliveryChallanDto,
    run,
    saveChallanTemplate,
    saveConversionOverride,
  } = ctx;

app.get('/api/delivery-challans/health', (_req, res) => {
  res.json({
    success: true,
    module: 'delivery-challans',
  });
});

app.get('/api/challans', requirePermission('config.read'), handleListChallans);

app.get('/api/delivery-challans', requirePermission('config.read'), handleListChallans);

app.post('/api/challans', requirePermission('config.write'), handleCreateChallan);

app.post('/api/delivery-challans', requirePermission('config.write'), handleCreateChallan);

app.post('/api/challans/:id/piece-barcodes', requirePermission('config.write'), async (req, res) => {
  try {
    const challanId = Number(req.params.id);
    if (!Number.isInteger(challanId) || challanId <= 0) {
      return res.status(400).json({ success: false, data: null, error: 'Invalid challan id.' });
    }
    const challan = await get('SELECT id FROM delivery_challans WHERE id = ?', [challanId]);
    if (!challan) {
      return res.status(404).json({ success: false, data: null, error: 'Challan not found.' });
    }

    const incoming = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
    const itemRows = await all('SELECT id FROM delivery_challan_items WHERE challan_id = ?', [challanId]);
    const validItemIds = new Set(itemRows.map((row) => row.id));

    const clean = [];
    const touchedItemIds = new Set();
    for (const pb of incoming) {
      const itemId = Number(pb.challanItemId ?? pb.challan_item_id);
      if (!validItemIds.has(itemId)) {
        return res.status(400).json({
          success: false,
          data: null,
          error: `Barcode references an item that is not part of challan ${challanId}.`,
        });
      }
      const parentCode = String(pb.parentCode ?? pb.parent_code ?? '').trim();
      const childCode = String(pb.childCode ?? pb.child_code ?? '').trim();
      if (!parentCode || !childCode) continue;
      const weightNum = Number(pb.weight ?? 0);
      clean.push({
        itemId,
        parentCode,
        childCode,
        weight: Number.isFinite(weightNum) && weightNum >= 0 ? weightNum : 0,
      });
      touchedItemIds.add(itemId);
    }

    const now = nowIso();
    await run('BEGIN TRANSACTION');
    try {
      for (const itemId of touchedItemIds) {
        await run('DELETE FROM piece_barcodes WHERE challan_item_id = ?', [itemId]);
      }
      for (const pb of clean) {
        await run(
          'INSERT INTO piece_barcodes (challan_item_id, parent_code, child_code, weight, created_at) VALUES (?, ?, ?, ?, ?)',
          [pb.itemId, pb.parentCode, pb.childCode, pb.weight, now],
        );
      }
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }

    const saved = await getDeliveryChallanRowById(challanId);
    const dto = await rowToDeliveryChallanDto(saved);
    res.json({ success: true, data: dto, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.get('/api/challans/:id', requirePermission('config.read'), handleGetChallan);

app.get('/api/delivery-challans/:id', requirePermission('config.read'), handleGetChallan);

app.put('/api/challans/:id', requirePermission('config.write'), handleUpdateChallan);

app.put('/api/delivery-challans/:id', requirePermission('config.write'), handleUpdateChallan);

app.post('/api/challans/:id/issue', requirePermission('config.write'), handleIssueChallan);

app.post('/api/delivery-challans/:id/issue', requirePermission('config.write'), handleIssueChallan);

app.post('/api/challans/:id/reconcile', requirePermission('config.write'), handleReconcileChallan);

app.post('/api/delivery-challans/:id/reconcile', requirePermission('config.write'), handleReconcileChallan);

app.post('/api/challans/:id/cancel', requirePermission('config.write'), handleCancelChallan);

app.post('/api/delivery-challans/:id/cancel', requirePermission('config.write'), handleCancelChallan);

app.get('/api/challans/:id/cancel-options', requirePermission('config.write'), handleGetCancelOptions);

app.get('/api/delivery-challans/:id/cancel-options', requirePermission('config.write'), handleGetCancelOptions);

app.patch('/api/challans/:id/report-groups', requirePermission('config.write'), handleUpdateChallanReportGroups);

app.patch('/api/delivery-challans/:id/report-groups', requirePermission('config.write'), handleUpdateChallanReportGroups);

app.get('/api/invoices', requirePermission('config.read'), async (req, res) => {
  try {
    res.json({ success: true, data: await listInvoices(), error: null });
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
    const invoice = await getInvoiceDtoById(Number(req.params.id));
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
    const buffer = await generateInvoicePdf(invoiceId);
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
    const updatedInvoice = await getInvoiceDtoById(invoiceId);
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
      
      // There is no `prepare()` in this codebase — the db helper surface is
      // run/get/all. Referencing it made every invoice edit throw a
      // ReferenceError after the lines had already been deleted (the
      // surrounding transaction rolled it back, so no data was lost, but the
      // endpoint could never succeed).
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
            line.itemName, line.hsnCode, line.quantity, line.unitPrice, line.taxableValue,
            line.cgstRate, line.sgstRate, line.cgstAmount, line.sgstAmount, now, now,
          ],
        );
      }
      await run('COMMIT');
      
      const invoice = await getInvoiceDtoById(id);
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
    const invoice = await createInvoice(req.body || {});
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

app.get('/api/reconciliation/report', requirePermission('config.read'), async (req, res) => {
  try {
    res.json({ success: true, data: await buildReconciliationReport(), error: null });
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
    res.json({ success: true, data: await listConversionOverrides(), error: null });
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
    res.json({ success: true, data: await saveConversionOverride(req.body || {}), error: null });
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
    res.json({ success: true, data: await listWasteAuditRows(), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: [],
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/reports/client-statement', requirePermission('config.read'), async (req, res) => {
  try {
    res.json({ success: true, data: await buildClientStatementReport(req.body || {}), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challans/:id/print', requirePermission('config.write'), handlePrintChallan);

app.post('/api/delivery-challans/:id/print', requirePermission('config.write'), handlePrintChallan);

app.delete('/api/challans/:id', requirePermission('config.write'), handleDeleteChallan);

app.delete('/api/delivery-challans/:id', requirePermission('config.write'), handleDeleteChallan);

app.get('/api/challan-templates', requirePermission('config.read'), async (req, res) => {
  try {
    const templates = await listChallanTemplates({
      partyType: req.query.partyType || req.query.party_type || '',
      partyId: req.query.partyId || req.query.party_id,
      challanType: req.query.challanType || req.query.challan_type || '',
      activeOnly: parseBooleanEnv(req.query.activeOnly || req.query.active_only, false),
    });
    res.json({ success: true, templates, data: templates, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      templates: [],
      data: [],
      message: error.message,
      error: error.message,
    });
  }
});

app.get('/api/challan-templates/scans', requirePermission('config.read'), async (req, res) => {
  try {
    const scans = await listChallanTemplateScans({
      limit: req.query.limit,
    });
    res.json({ success: true, scans, data: scans, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      scans: [],
      data: [],
      message: error.message,
      error: error.message,
    });
  }
});

app.get('/api/challan-templates/:id', requirePermission('config.read'), async (req, res) => {
  try {
    const template = await getChallanTemplateRowById(Number(req.params.id));
    if (!template) {
      res.status(404).json({
        success: false,
        template: null,
        data: null,
        message: 'Challan template not found.',
        error: 'Challan template not found.',
      });
      return;
    }
    const dto = await rowToChallanTemplateDto(template);
    res.json({ success: true, template: dto, data: dto, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      template: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates', requirePermission('config.write'), async (req, res) => {
  try {
    const template = await saveChallanTemplate(req.body || {});
    res.status(201).json({ success: true, template, data: template, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      template: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.patch('/api/challan-templates/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const template = await saveChallanTemplate(req.body || {}, Number(req.params.id));
    res.json({ success: true, template, data: template, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      template: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.delete('/api/challan-templates/:id', requirePermission('config.write'), async (req, res) => {
  try {
    await deleteChallanTemplate(Number(req.params.id));
    res.json({ success: true, data: null, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates/upload-intent', requirePermission('config.write'), async (req, res) => {
  try {
    const upload = await createChallanTemplateUploadIntent({
      ...(req.body || {}),
      uploadType: 'CHALLAN_TEMPLATE_BACKGROUND',
    });
    res.status(201).json({ success: true, upload, data: upload, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      upload: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates/upload-complete', requirePermission('config.write'), async (req, res) => {
  try {
    const background = await completeChallanTemplateUpload(req.body || {});
    res.json({ success: true, background, data: background, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      background: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates/stamp-upload-intent', requirePermission('config.write'), async (req, res) => {
  try {
    const upload = await createChallanTemplateUploadIntent({
      ...(req.body || {}),
      uploadType: 'CHALLAN_TEMPLATE_STAMP',
    });
    res.status(201).json({ success: true, upload, data: upload, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      upload: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates/stamp-upload-complete', requirePermission('config.write'), async (req, res) => {
  try {
    const stamp = await completeChallanTemplateUpload(req.body || {});
    res.json({ success: true, stamp, data: stamp, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      stamp: null,
      data: null,
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/challan-templates/test-print', requirePermission('config.read'), async (req, res) => {
  await handleChallanTemplateTestPrint(req, res);
});

app.get('/api/challan-templates/test-print', requirePermission('config.read'), async (req, res) => {
  await handleChallanTemplateTestPrint(req, res);
});

app.get('/api/templates/:id/test-print', requirePermission('config.read'), async (req, res) => {
  await handleChallanTemplateTestPrint(req, res);
});

app.get('/api/challans/:id/print-template-preview', requirePermission('config.read'), async (req, res) => {
  try {
    const challan = await getDeliveryChallanRowById(Number(req.params.id));
    if (!challan) {
      res.status(404).json({
        success: false,
        message: 'Challan not found.',
        error: 'Challan not found.',
      });
      return;
    }
    const snapshot = parseJsonObject(challan.template_snapshot_json, null);
    const useSnapshot = challan.status !== 'draft' && snapshot;
    const templateId = Number(req.query.templateId || req.query.template_id || 0);
    const template = useSnapshot
      ? null
      : templateId > 0
      ? await getChallanTemplateRowById(templateId)
      : await findActiveChallanTemplateForChallan(challan);
    if (!useSnapshot && !template) {
      res.status(404).json({
        success: false,
        message: 'Matching challan template not found.',
        error: 'Matching challan template not found.',
      });
      return;
    }
    const buffer = await generateChallanTemplatePdf({
      challanRow: challan,
      templateRow: template,
      templateSnapshot: useSnapshot ? snapshot : null,
      mode: req.query.mode,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(challan.challan_no || 'challan').replace(/[^a-zA-Z0-9_.-]/g, '_')}-${String(req.query.mode || 'digital')}.pdf"`,
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

app.post('/api/delivery-challans/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
  try {
    const entityId = Number(req.params.id);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      res.status(400).json({
        success: false,
        intent: null,
        error: 'A valid challan id is required.',
      });
      return;
    }
    const requestedEntityId = req.body?.entityId;
    if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
      res.status(400).json({
        success: false,
        intent: null,
        error: 'Request challan id does not match the upload route challan id.',
      });
      return;
    }
    const intent = await createAssetUploadIntent({
      ...(req.body || {}),
      entityType: 'delivery_challan',
      entityId,
    });
    res.status(intent.alreadyUploaded ? 200 : 201).json({
      success: true,
      intent,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      intent: null,
      error: error.message,
    });
  }
});

app.post('/api/delivery-challans/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
  try {
    const entityId = Number(req.params.id);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      res.status(400).json({
        success: false,
        asset: null,
        error: 'A valid challan id is required.',
      });
      return;
    }
    const requestedEntityId = req.body?.entityId;
    if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
      res.status(400).json({
        success: false,
        asset: null,
        error: 'Request challan id does not match the upload route challan id.',
      });
      return;
    }
    // `handleAssetUploadComplete` does not exist — this route always threw a
    // ReferenceError. completeAssetUpload() is the real entry point and it
    // already returns a DTO, so no second conversion is needed. Ownership is
    // then checked the same way the items variant does it.
    const asset = await completeAssetUpload(req.body || {});
    if (asset.entityType !== 'delivery_challan' || Number(asset.entityId) !== entityId) {
      res.status(400).json({
        success: false,
        asset: null,
        error: 'Completed upload does not belong to the requested challan.',
      });
      return;
    }
    res.status(200).json({
      success: true,
      asset,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      asset: null,
      error: error.message,
    });
  }
});
};
