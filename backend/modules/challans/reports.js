'use strict';

// ---------------------------------------------------------------------------
// Challan reports: what went out against what came back, in weight and units.
//
//   - the reconciliation report (issued against billed, per item and variation,
//     using conversion ratios the user can override), which also rewrites the
//     waste audit rows as it runs;
//   - conversion overrides and the waste audit;
//   - the client statement, which marks the challans it includes as reported;
//   - the reconciliation of ONE order: its lines against its challans, runs,
//     consumed barcodes and stage reconciliations.
//
// These read orders', production's and inventory's tables as well as challans'.
// They keep their SQL on purpose: each is one read model. Takes {get, all, run}
// plus the invoice list and the report-group helpers by name.
// ---------------------------------------------------------------------------

function createChallanReportService({
  get,
  all,
  run,
  normalizeChallanType,
  normalizeReportGroupCode,
  effectiveReportGroupCodesForChallan,
  listInvoices,
  normalizePositiveNumber,
  desk,
}) {
  function rowToConversionOverrideDto(row) {
    return {
      id: Number(row.id || 0),
      itemId: Number(row.item_id || 0),
      variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
      conversionRatio: Number(row.conversion_ratio || 1) || 1,
      fromUnit: row.from_unit || 'kg',
      toUnitLabel: row.to_unit_label || 'units',
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  function rowToWasteAuditDto(row) {
    return {
      id: Number(row.id || 0),
      auditTime: row.created_at || null,
      clientId: row.client_id || null,
      clientName: row.client_name || '',
      itemId: row.item_id || null,
      variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
      itemName: row.item_name || '',
      challanId: row.challan_id || null,
      challanNo: row.challan_no || '',
      inputWeightKg: Number(row.input_weight_kg || 0),
      shippedWeightKg: Number(row.shipped_weight_kg || 0),
      wasteWeightKg: Number(row.waste_weight_kg || 0),
      wastePercentage: Number(row.waste_percentage || 0),
      source: row.source || 'report_snapshot',
    };
  }

  async function listConversionOverrides() {
    const rows = await all(
      `
      SELECT *
      FROM reconciliation_conversion_overrides
      ORDER BY updated_at DESC, id DESC
      `,
    );
    return rows.map(rowToConversionOverrideDto);
  }

  async function saveConversionOverride(input = {}) {
    const itemId = Number(input.itemId ?? input.item_id ?? 0);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      const error = new Error('itemId is required for conversion override.');
      error.statusCode = 400;
      throw error;
    }
    const variationLeafNodeId = Number(input.variationLeafNodeId ?? input.variation_leaf_node_id ?? 0) || 0;
    const conversionRatio = normalizePositiveNumber(
      input.conversionRatio ?? input.conversion_ratio ?? 1,
      'Conversion ratio',
    );
    const fromUnit = String(input.fromUnit ?? input.from_unit ?? 'kg').trim() || 'kg';
    const toUnitLabel = String(input.toUnitLabel ?? input.to_unit_label ?? 'units').trim() || 'units';
    const now = new Date().toISOString();
    await run(
      `
      INSERT INTO reconciliation_conversion_overrides (
        item_id, variation_leaf_node_id, conversion_ratio, from_unit, to_unit_label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, variation_leaf_node_id)
      DO UPDATE SET
        conversion_ratio = excluded.conversion_ratio,
        from_unit = excluded.from_unit,
        to_unit_label = excluded.to_unit_label,
        updated_at = excluded.updated_at
      `,
      [itemId, variationLeafNodeId, conversionRatio, fromUnit, toUnitLabel, now, now],
    );
    const row = await get(
      `
      SELECT *
      FROM reconciliation_conversion_overrides
      WHERE item_id = ? AND variation_leaf_node_id = ?
      `,
      [itemId, variationLeafNodeId],
    );
    return rowToConversionOverrideDto(row);
  }

  async function listWasteAuditRows() {
    const rows = await all(
      `
      SELECT *
      FROM reconciliation_waste_audit
      ORDER BY datetime(created_at) DESC, id DESC
      `,
    );
    return rows.map(rowToWasteAuditDto);
  }

  function conversionKey(itemId, variationLeafNodeId) {
    return `${Number(itemId || 0)}:${Number(variationLeafNodeId || 0)}`;
  }

  function safeRatio(value) {
    const ratio = Number(value);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  function lineMeasureToWeightKg(line, ratio) {
    const weight = Number(line.weight || 0);
    if (Number.isFinite(weight) && weight > 0) {
      return weight;
    }
    const qty = Number(line.quantity_pcs || 0);
    return Number.isFinite(qty) && qty > 0 ? qty / safeRatio(ratio) : 0;
  }

  function lineMeasureToUnits(line, ratio) {
    const qty = Number(line.quantity_pcs || 0);
    if (Number.isFinite(qty) && qty > 0) {
      return qty;
    }
    const weight = Number(line.weight || 0);
    return Number.isFinite(weight) && weight > 0 ? weight * safeRatio(ratio) : 0;
  }

  function roundMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
  }

  async function buildReconciliationReport() {
    const overrides = await listConversionOverrides();
    const overrideMap = new Map(
      overrides.map((override) => [
        conversionKey(override.itemId, override.variationLeafNodeId),
        override,
      ]),
    );
    const invoices = await listInvoices();
    const invoiceLines = invoices.flatMap((invoice) =>
      invoice.lines.map((line) => ({ ...line, invoice })),
    );
    const invoiceLinesByChallanItem = new Map();
    for (const line of invoiceLines) {
      if (!line.challanItemId) {
        continue;
      }
      const existing = invoiceLinesByChallanItem.get(line.challanItemId) || [];
      existing.push(line);
      invoiceLinesByChallanItem.set(line.challanItemId, existing);
    }

    const issuedChallans = await all(
      `
      SELECT *
      FROM delivery_challans
      WHERE status = 'issued'
      ORDER BY date(date) ASC, id ASC
      `,
    );
    const challanItems = await all(
      `
      SELECT dci.*, dc.type, dc.challan_no, dc.customer_name, dc.customer_gstin,
             dc.material_owner_client_id, dc.material_owner_client_name, dc.material_owner_gstin,
             dc.maintain_stocks, dc.date, dc.order_id,
             o.client_id AS delivery_client_id,
             o.client_name AS delivery_client_name,
             o.unit_price AS order_unit_price,
             o.total_invoiced_qty AS order_total_invoiced_qty
      FROM delivery_challan_items dci
      JOIN delivery_challans dc ON dc.id = dci.challan_id
      LEFT JOIN order_items o ON o.id = dci.order_item_id
      WHERE dc.status = 'issued'
      ORDER BY date(dc.date) ASC, dc.id ASC, dci.line_no ASC, dci.id ASC
      `,
    );

    const inputByClientItem = new Map();
    for (const row of challanItems) {
      if (normalizeChallanType(row.type) !== 'reception') {
        continue;
      }
      const ownerClientId = Number(row.material_owner_client_id || 0);
      if (!ownerClientId) {
        continue;
      }
      const override = overrideMap.get(conversionKey(row.item_id, row.variation_leaf_node_id));
      const ratio = safeRatio(override?.conversionRatio);
      const key = `${ownerClientId}:${conversionKey(row.item_id, row.variation_leaf_node_id)}`;
      const existing = inputByClientItem.get(key) || {
        clientId: ownerClientId,
        clientName: row.material_owner_client_name || '',
        itemId: row.item_id || null,
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        itemName: row.particulars || '',
        inputWeightKg: 0,
      };
      existing.inputWeightKg += lineMeasureToWeightKg(row, ratio);
      inputByClientItem.set(key, existing);
    }

    const shippedByClientItem = new Map();
    const auditorRows = [];
    for (const row of challanItems) {
      if (normalizeChallanType(row.type) !== 'delivery') {
        continue;
      }
      const clientId = Number(row.delivery_client_id || 0) || null;
      const effectiveClientName = String(row.delivery_client_name || row.customer_name || 'Unlinked party').trim() || 'Unlinked party';
      const override = overrideMap.get(conversionKey(row.item_id, row.variation_leaf_node_id));
      const ratio = safeRatio(override?.conversionRatio);
      const dispatchedWeightKg = lineMeasureToWeightKg(row, ratio);
      const convertedUnits = lineMeasureToUnits(row, ratio);
      const linkedInvoiceLines = invoiceLinesByChallanItem.get(Number(row.id)) || [];
      const invoicedQuantity = linkedInvoiceLines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
      const cgst = linkedInvoiceLines.reduce((sum, line) => sum + Number(line.cgstAmount || 0), 0);
      const sgst = linkedInvoiceLines.reduce((sum, line) => sum + Number(line.sgstAmount || 0), 0);
      const cgstRate = linkedInvoiceLines.find((line) => Number(line.cgstRate || 0) > 0)?.cgstRate || 0;
      const sgstRate = linkedInvoiceLines.find((line) => Number(line.sgstRate || 0) > 0)?.sgstRate || 0;
      const gstin = linkedInvoiceLines.find((line) => String(line.invoice?.gstin || '').trim())?.invoice?.gstin ||
        row.customer_gstin ||
        '';
      const clientItemKey = `${clientId || 0}:${conversionKey(row.item_id, row.variation_leaf_node_id)}`;
      const shippedExisting = shippedByClientItem.get(clientItemKey) || {
        clientId,
        clientName: effectiveClientName,
        itemId: row.item_id || null,
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        itemName: row.particulars || '',
        shippedWeightKg: 0,
        deliveredUnits: 0,
        lastChallanId: row.challan_id,
        lastChallanNo: row.challan_no || '',
      };
      shippedExisting.shippedWeightKg += dispatchedWeightKg;
      shippedExisting.deliveredUnits += convertedUnits;
      shippedExisting.lastChallanId = row.challan_id;
      shippedExisting.lastChallanNo = row.challan_no || '';
      shippedByClientItem.set(clientItemKey, shippedExisting);
      const inputKey = `${clientId || 0}:${conversionKey(row.item_id, row.variation_leaf_node_id)}`;
      const input = inputByClientItem.get(inputKey);
      const inputWeightKg = input?.inputWeightKg || 0;
      const wasteWeightKg = Math.max(inputWeightKg - shippedExisting.shippedWeightKg, 0);
      const wastePercentage = inputWeightKg > 0 ? wasteWeightKg / inputWeightKg * 100 : 0;
      const denominator = Math.max(Math.abs(convertedUnits), 1);
      const variance = Math.abs(convertedUnits - invoicedQuantity) / denominator;
      const isDirectPrint = Number(row.maintain_stocks ?? 1) === 0 || !row.order_item_id;
      const invoiceableQuantity = Math.max(convertedUnits - invoicedQuantity, 0);
      const unitPrice = Number(row.order_unit_price || 0);
      const status = isDirectPrint
        ? 'Unlinked / Direct Print'
        : invoicedQuantity <= 0
          ? 'Unbilled / In Transit'
          : variance <= 0.02
            ? 'Auto Reconciled'
            : 'Attention Required';
      auditorRows.push({
        challanId: Number(row.challan_id || 0),
        challanItemId: Number(row.id || 0),
        orderId: Number(row.order_item_id || 0) || null,
        dcNumber: row.challan_no || '',
        challanDate: row.date || null,
        clientId,
        clientName: effectiveClientName,
        itemId: row.item_id || null,
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        itemName: row.particulars || '',
        hsnCode: row.hsn_code || '',
        totalDispatchedWeightKg: roundMetric(dispatchedWeightKg),
        convertedUnits: roundMetric(convertedUnits),
        invoicedQuantity: roundMetric(invoicedQuantity),
        invoiceableQuantity: roundMetric(invoiceableQuantity),
        unitPrice: roundMetric(unitPrice),
        financialExposure: roundMetric(invoiceableQuantity * unitPrice),
        gstin,
        cgst: roundMetric(cgst),
        sgst: roundMetric(sgst),
        cgstRate: roundMetric(cgstRate),
        sgstRate: roundMetric(sgstRate),
        wastePercentage: roundMetric(wastePercentage),
        conversionRatio: roundMetric(ratio),
        toUnitLabel: override?.toUnitLabel || 'units',
        variancePercent: roundMetric(variance * 100),
        status,
        unlinkedReason: isDirectPrint
          ? (Number(row.maintain_stocks ?? 1) === 0
            ? 'Document-only challan line does not carry an inventory/order reference.'
            : 'Line is not linked to an order item.')
          : '',
        isAttentionRequired: status === 'Attention Required',
        isDirectPrint,
        isUnbilled: invoicedQuantity < convertedUnits,
        invoiceLineIds: linkedInvoiceLines.map((line) => line.id),
        linkedInvoices: linkedInvoiceLines.map((line) => ({
          id: line.invoice?.id || line.invoiceId,
          invoiceNo: line.invoice?.invoiceNo || '',
          status: line.invoice?.status || '',
          invoiceDate: line.invoice?.invoiceDate || null,
        })),
      });
    }

    const clientRows = [];
    for (const [key, input] of inputByClientItem.entries()) {
      const shipped = shippedByClientItem.get(key) || {
        shippedWeightKg: 0,
        deliveredUnits: 0,
      };
      const balance = input.inputWeightKg - shipped.shippedWeightKg;
      clientRows.push({
        clientId: input.clientId || null,
        clientName: input.clientName || 'Client supplied material',
        itemId: input.itemId,
        variationLeafNodeId: input.variationLeafNodeId,
        itemName: input.itemName,
        materialReceivedInputKg: roundMetric(input.inputWeightKg),
        totalFinishedUnitsDelivered: roundMetric(shipped.deliveredUnits || 0),
        netBalanceMaterialRemainingKg: roundMetric(balance),
        status: balance < -0.001
          ? 'Over Dispatched'
          : balance > 0.001
            ? 'Material Remaining'
            : 'Balanced',
      });
    }

    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      await run("DELETE FROM reconciliation_waste_audit WHERE source = 'report_snapshot'");
      for (const shipped of shippedByClientItem.values()) {
        const inputKey = `${shipped.clientId || 0}:${conversionKey(shipped.itemId, shipped.variationLeafNodeId)}`;
        const input = inputByClientItem.get(inputKey);
        const inputWeightKg = input?.inputWeightKg || 0;
        const wasteWeightKg = Math.max(inputWeightKg - shipped.shippedWeightKg, 0);
        const wastePercentage = inputWeightKg > 0 ? wasteWeightKg / inputWeightKg * 100 : 0;
        await run(
          `
          INSERT INTO reconciliation_waste_audit (
            client_id, client_name, item_id, variation_leaf_node_id, item_name,
            challan_id, challan_no, input_weight_kg, shipped_weight_kg,
            waste_weight_kg, waste_percentage, source, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'report_snapshot', ?)
          `,
          [
            shipped.clientId,
            shipped.clientName,
            shipped.itemId,
            shipped.variationLeafNodeId,
            shipped.itemName,
            shipped.lastChallanId,
            shipped.lastChallanNo,
            inputWeightKg,
            shipped.shippedWeightKg,
            wasteWeightKg,
            wastePercentage,
            now,
          ],
        );
      }
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    const wasteAuditRows = await listWasteAuditRows();
    return {
      internalAuditor: auditorRows,
      clientStatement: clientRows,
      misc: wasteAuditRows,
      conversionOverrides: overrides,
      generatedAt: now,
    };
  }

  async function buildClientStatementReport(input = {}) {
    const requestedReportGroupCode = normalizeReportGroupCode(
      input.reportGroupCode ?? input.report_group_code ?? '',
    );
    const challanIds = Array.isArray(input.challanIds)
      ? input.challanIds
      : Array.isArray(input.challan_ids)
        ? input.challan_ids
        : [];
    const requestedChallanNos = [
      ...new Set(
        challanIds
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ];
    if (requestedChallanNos.length === 0) {
      const error = new Error('At least one challan number is required.');
      error.statusCode = 400;
      throw error;
    }

    const receptionChallanIds = Array.isArray(input.receptionChallanIds)
      ? input.receptionChallanIds
      : Array.isArray(input.reception_challan_ids)
        ? input.reception_challan_ids
        : [];
    const requestedReceptionNos = [
      ...new Set(
        receptionChallanIds
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ];

    if (requestedReceptionNos.length === 0) {
      const error = new Error('At least one reception challan is required to generate the statement report.');
      error.statusCode = 400;
      throw error;
    }

    const placeholders = requestedChallanNos.map(() => '?').join(', ');
    const challans = await all(
      `
      SELECT *
      FROM delivery_challans
      WHERE challan_no IN (${placeholders})
      `,
      requestedChallanNos,
    );
    const foundNos = new Set(challans.map((row) => String(row.challan_no || '').trim()));
    const missingNos = requestedChallanNos.filter((challanNo) => !foundNos.has(challanNo));
    if (missingNos.length > 0) {
      const error = new Error(`Unknown challan number(s): ${missingNos.join(', ')}.`);
      error.statusCode = 400;
      throw error;
    }
    const invalidNos = challans
      .filter((row) => normalizeChallanType(row.type) !== 'delivery' || row.status !== 'issued')
      .map((row) => row.challan_no);
    if (invalidNos.length > 0) {
      const error = new Error(`Only issued delivery challans can be exported. Invalid: ${invalidNos.join(', ')}.`);
      error.statusCode = 400;
      throw error;
    }

    if (requestedReportGroupCode) {
      const mismatched = [];
      for (const row of challans) {
        const codes = await effectiveReportGroupCodesForChallan(row);
        if (!codes.includes(requestedReportGroupCode)) {
          mismatched.push(row.challan_no);
        }
      }
      if (mismatched.length > 0) {
        const error = new Error(
          `Delivery challans outside report group ${requestedReportGroupCode}: ${mismatched.join(', ')}.`,
        );
        error.statusCode = 400;
        throw error;
      }
    }

    const receptionPlaceholders = requestedReceptionNos.map(() => '?').join(', ');
    const receptionChallans = await all(
      `
      SELECT *
      FROM delivery_challans
      WHERE challan_no IN (${receptionPlaceholders})
      `,
      requestedReceptionNos,
    );
    const foundReceptionNos = new Set(receptionChallans.map((row) => String(row.challan_no || '').trim()));
    const missingReceptionNos = requestedReceptionNos.filter((challanNo) => !foundReceptionNos.has(challanNo));
    if (missingReceptionNos.length > 0) {
      const error = new Error(`Unknown reception challan number(s): ${missingReceptionNos.join(', ')}.`);
      error.statusCode = 400;
      throw error;
    }
    const invalidReceptionNos = receptionChallans
      .filter((row) => normalizeChallanType(row.type) !== 'reception' || row.status !== 'issued')
      .map((row) => row.challan_no);
    if (invalidReceptionNos.length > 0) {
      const error = new Error(`Only issued reception challans can be used. Invalid: ${invalidReceptionNos.join(', ')}.`);
      error.statusCode = 400;
      throw error;
    }

    if (requestedReportGroupCode) {
      const mismatched = [];
      for (const row of receptionChallans) {
        const codes = await effectiveReportGroupCodesForChallan(row);
        if (!codes.includes(requestedReportGroupCode)) {
          mismatched.push(row.challan_no);
        }
      }
      if (mismatched.length > 0) {
        const error = new Error(
          `Reception challans outside report group ${requestedReportGroupCode}: ${mismatched.join(', ')}.`,
        );
        error.statusCode = 400;
        throw error;
      }
    }

    const rows = await all(
      `
      SELECT dc.date, dc.challan_no, dc.customer_name, dc.order_no,
             dci.particulars, dci.note, dci.quantity_pcs, dci.weight
      FROM delivery_challans dc
      JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      WHERE dc.challan_no IN (${placeholders})
        AND dc.type = 'delivery'
        AND dc.status = 'issued'
      ORDER BY date(dc.date) ASC, dc.id ASC, dci.line_no ASC, dci.id ASC
      `,
      requestedChallanNos,
    );
    const reportRows = rows.map((row) => ({
      date: row.date || null,
      challanNo: row.challan_no || '',
      clientName: row.customer_name || '',
      orderNo: row.order_no || '',
      itemName: row.particulars || '',
      note: row.note || '',
      quantityPcs: roundMetric(Number(row.quantity_pcs || 0)),
      weight: roundMetric(Number(row.weight || 0)),
    }));

    const receptionRows = await all(
      `
      SELECT dc.date, dc.challan_no, dc.customer_name,
             dci.particulars, dci.quantity_pcs, dci.weight
      FROM delivery_challans dc
      JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      WHERE dc.challan_no IN (${receptionPlaceholders})
        AND dc.type = 'reception'
        AND dc.status = 'issued'
      ORDER BY date(dc.date) ASC, dc.id ASC, dci.line_no ASC, dci.id ASC
      `,
      requestedReceptionNos,
    );

    const bins = receptionRows.map((r, index) => ({
      id: index,
      challanNo: r.challan_no || '',
      date: r.date || null,
      size: r.particulars || '',
      capacity: Number(r.weight || 0),
      allocatedWeight: 0,
      deliveries: []
    }));

    // Group delivery items by delivery challan
    const deliveryChallansMap = new Map();
    for (const item of reportRows) {
      if (!deliveryChallansMap.has(item.challanNo)) {
        deliveryChallansMap.set(item.challanNo, {
          challanNo: item.challanNo,
          date: item.date,
          items: []
        });
      }
      deliveryChallansMap.get(item.challanNo).items.push(item);
    }
    const deliveryChallansList = Array.from(deliveryChallansMap.values());
    for (const dc of deliveryChallansList) {
      dc.totalWeight = dc.items.reduce((sum, item) => sum + item.weight, 0);
    }

    // Perform First-Fit allocation
    for (const dc of deliveryChallansList) {
      let allocated = false;
      for (const bin of bins) {
        if (bin.allocatedWeight + dc.totalWeight <= bin.capacity + 0.0001) {
          bin.deliveries.push(...dc.items);
          bin.allocatedWeight += dc.totalWeight;
          allocated = true;
          break;
        }
      }
      if (!allocated) {
        if (bins.length > 0) {
          // Fallback: over-allocate to the first available reception challan
          bins[0].deliveries.push(...dc.items);
          bins[0].allocatedWeight += dc.totalWeight;
        } else {
          const error = new Error(`No reception challans available to cover delivery challan ${dc.challanNo}.`);
          error.statusCode = 400;
          throw error;
        }
      }
    }

    const receptionGroups = bins.map((bin) => {
      const less = Math.max(0, bin.capacity - bin.allocatedWeight);
      return {
        receptionChallanNo: bin.challanNo,
        receptionDate: bin.date,
        receptionSize: bin.size,
        receptionWeight: roundMetric(bin.capacity),
        lessWeight: roundMetric(less),
        totalWeight: roundMetric(bin.capacity),
        deliveries: bin.deliveries.map(d => ({
          date: d.date,
          challanNo: d.challanNo,
          particulars: d.itemName,
          note: d.note,
          weight: roundMetric(d.weight),
          quantityPcs: roundMetric(d.quantityPcs)
        }))
      };
    });

    const summary = reportRows.reduce(
      (acc, row) => {
        acc.totalQuantityPcs += Number(row.quantityPcs || 0);
        acc.totalWeight += Number(row.weight || 0);
        return acc;
      },
      {
        challanCount: requestedChallanNos.length,
        totalQuantityPcs: 0,
        totalWeight: 0,
      },
    );
    summary.totalQuantityPcs = roundMetric(summary.totalQuantityPcs);
    summary.totalWeight = roundMetric(summary.totalWeight);

    const generatedAt = new Date().toISOString();
    const allChallanNosToUpdate = [...requestedChallanNos, ...requestedReceptionNos];
    const updatePlaceholders = allChallanNosToUpdate.map(() => '?').join(', ');
    await run(
      `
      UPDATE delivery_challans
      SET used_in_report = 1, updated_at = ?
      WHERE challan_no IN (${updatePlaceholders})
      `,
      [generatedAt, ...allChallanNosToUpdate],
    );

    return {
      rows: reportRows,
      summary,
      generatedAt,
      receptionGroups,
    };
  }

  // ---------------------------------------------------------------------------
  // Order reconciliation — what a finished order consumed, produced and shipped.
  //
  // The statement people actually want is per order, because the order is the
  // only thing that knows what was asked for and how much of it has been met. It
  // is assembled by walking links that already exist; nothing here needs a column
  // that is not already on a table:
  //
  //   order_items                                    the order's lines
  //     ← delivery_challan_items.order_item_id       what shipped against them
  //     ← delivery_challans.order_no                 the challans those lines are on
  //     ← order_pipeline_assignments.order_item_id   the runs that made it
  //         → run_barcode_inputs.run_id              the stock those runs consumed
  //             → inventory_movements.source_challan_id   the reception it came in on
  //         → stage_reconciliations.run_id           scrap and yield per stage
  //
  // The last two hops are the fragile ones, and the report says so rather than
  // printing a zero. Stock that was never assigned to a run, and stock created
  // without a reception challan behind it, cannot be attributed to an order by
  // any means — so `coverage` reports what could not be traced and why, and a
  // caller can tell "nothing came in" apart from "we do not know what came in".
  // ---------------------------------------------------------------------------
  async function buildOrderReconciliation(input = {}) {
    const orderNo = String(input.orderNo ?? input.order_no ?? '').trim();
    if (!orderNo) {
      const error = new Error('An order number is required.');
      error.statusCode = 400;
      throw error;
    }

    const { rows: orderLines } = await desk.ask('orders.rows.forOrderNo', { orderNo });
    if (orderLines.length === 0) {
      const error = new Error(`Unknown order: ${orderNo}.`);
      error.statusCode = 404;
      throw error;
    }

    const orderItemIds = orderLines.map((row) => row.id);
    const inClause = (values) => values.map(() => '?').join(', ');

    // --- out: what shipped, and when -----------------------------------------
    const deliveryRows = await all(
      `
      SELECT c.id AS challan_id, c.challan_no, c.date, c.status,
             ci.id AS line_id, ci.order_item_id, ci.item_id, ci.particulars,
             ci.quantity_pcs, ci.weight, ci.production_run_id,
             ci.variation_path_label
      FROM delivery_challans c
      JOIN delivery_challan_items ci ON ci.challan_id = c.id
      WHERE c.type = 'delivery' AND c.order_no = ?
      ORDER BY c.date ASC, ci.line_no ASC
      `,
      [orderNo],
    );

    const deliveries = new Map();
    for (const row of deliveryRows) {
      if (!deliveries.has(row.challan_id)) {
        deliveries.set(row.challan_id, {
          challanId: row.challan_id,
          challanNo: row.challan_no,
          date: row.date,
          status: row.status,
          lines: [],
        });
      }
      deliveries.get(row.challan_id).lines.push({
        orderItemId: row.order_item_id,
        itemId: row.item_id,
        particulars: row.particulars,
        variationPathLabel: row.variation_path_label || '',
        quantityPcs: Number(row.quantity_pcs || 0),
        weightKg: Number(row.weight || 0),
        productionRunId: row.production_run_id || null,
      });
    }

    // --- the runs that made it ------------------------------------------------
    const { runs: runRows } = await desk.ask('production.runs.summariesForOrderItems', { orderItemIds });
    const runIds = runRows.map((row) => row.id);

    // --- in: stock those runs consumed, and where it came from ----------------
    const { inputs: consumed } = await desk.ask('production.runs.inputsForRuns', { runIds });

    // Where the consumed stock came in.
    //
    // Preferred route is the bridge — a consumption names the challan line that
    // supplied it, whether it was consumed as a barcoded piece or as a quantity.
    // Falling back to matching on barcode covers stock recorded before the bridge
    // existed, which is most of what is in a workspace today.
    const challanItemIds = [
      ...new Set(consumed.map((row) => row.challan_item_id).filter(Boolean)),
    ];
    const barcodes = [...new Set(consumed.map((row) => row.barcode).filter(Boolean))];

    const bridged = challanItemIds.length === 0
      ? []
      : await all(
          `
          SELECT ci.id AS line_id, ci.quantity_pcs, ci.weight, ci.particulars,
                 c.id AS challan_id, c.challan_no, c.date, c.vendor_name
          FROM delivery_challan_items ci
          JOIN delivery_challans c ON c.id = ci.challan_id
          WHERE ci.id IN (${inClause(challanItemIds)}) AND c.type = 'reception'
          ORDER BY c.date ASC
          `,
          challanItemIds,
        );

    const legacy = barcodes.length === 0
      ? []
      : await all(
          `
          SELECT im.material_barcode, im.qty, im.primary_qty, im.uom,
                 c.id AS challan_id, c.challan_no, c.date, c.vendor_name
          FROM inventory_movements im
          JOIN delivery_challans c ON c.id = im.source_challan_id
          WHERE im.material_barcode IN (${inClause(barcodes)})
            AND c.type = 'reception'
          ORDER BY c.date ASC
          `,
          barcodes,
        );

    const receipts = [
      ...bridged.map((row) => ({
        challanId: row.challan_id,
        challanNo: row.challan_no,
        date: row.date,
        vendorName: row.vendor_name || '',
        challanLineId: row.line_id,
        particulars: row.particulars || '',
        quantity: Number(row.weight || row.quantity_pcs || 0),
        uom: '',
        via: 'challan-line',
      })),
      ...legacy
        // A receipt already reached through the bridge must not be counted twice.
        .filter((row) => !bridged.some((b) => b.challan_id === row.challan_id))
        .map((row) => ({
          challanId: row.challan_id,
          challanNo: row.challan_no,
          date: row.date,
          vendorName: row.vendor_name || '',
          barcode: row.material_barcode,
          quantity: Number(row.primary_qty ?? row.qty ?? 0),
          uom: row.uom || '',
          via: 'barcode',
        })),
    ];

    // --- scrap and yield, per stage, for those runs ---------------------------
    const scrapRow = runIds.length === 0
      ? null
      : (await desk.ask('production.runs.stageTotals', { runIds })).totals;

    // --- what could not be traced, said out loud ------------------------------
    const tracedBarcodes = new Set(
      receipts.map((row) => row.barcode).filter(Boolean),
    );
    const untracedBarcodes = consumed
      .filter((row) => !row.challan_item_id)
      .map((row) => row.barcode)
      .filter((code) => code && !tracedBarcodes.has(code));

    const deliveredPcs = deliveryRows.reduce(
      (total, row) => total + Number(row.quantity_pcs || 0),
      0,
    );
    const deliveredWeightKg = deliveryRows.reduce(
      (total, row) => total + Number(row.weight || 0),
      0,
    );
    const orderedQty = orderLines.reduce(
      (total, row) => total + Number(row.quantity || 0),
      0,
    );

    return {
      orderNo,
      clientName: orderLines[0]?.client_name || '',
      lines: orderLines.map((row) => ({
        orderItemId: row.id,
        itemId: row.item_id,
        itemName: row.item_name,
        variationPathLabel: row.variation_path_label || '',
        quantity: Number(row.quantity || 0),
        unitSymbol: row.unit_symbol || '',
        status: row.status || '',
      })),
      receipts,
      runs: runRows.map((row) => ({
        runId: row.id,
        name: row.name || '',
        status: row.status || '',
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
      deliveries: [...deliveries.values()],
      totals: {
        orderedQty,
        deliveredPcs,
        deliveredWeightKg: roundMetric(deliveredWeightKg),
        receivedQty: roundMetric(
          receipts.reduce((total, row) => total + row.quantity, 0),
        ),
        allotted: roundMetric(Number(scrapRow?.allotted || 0)),
        output: roundMetric(Number(scrapRow?.output || 0)),
        scrap: roundMetric(Number(scrapRow?.scrap || 0)),
        leftover: roundMetric(Number(scrapRow?.leftover || 0)),
      },
      // Never let a gap read as a zero. Each flag names something the walk could
      // not do, so the report can say "not recorded" instead of implying "none".
      coverage: {
        runsFound: runIds.length,
        consumedBarcodes: barcodes.length,
        // Stock was assigned to a run but has no reception behind it — created
        // directly in inventory, or received before receipts were itemised.
        untracedBarcodes,
        // No stock was assigned to any of this order's runs, so nothing can be
        // said about what went into it. This is the common case until assigning
        // stock becomes routine.
        inboundTraceable: runIds.length > 0 && barcodes.length > 0,
        deliveriesLinked: deliveries.size,
      },
    };
  }

  return {
    rowToConversionOverrideDto,
    rowToWasteAuditDto,
    listConversionOverrides,
    saveConversionOverride,
    listWasteAuditRows,
    conversionKey,
    safeRatio,
    lineMeasureToWeightKg,
    lineMeasureToUnits,
    roundMetric,
    buildReconciliationReport,
    buildClientStatementReport,
    buildOrderReconciliation,
  };
}

module.exports = { createChallanReportService };
