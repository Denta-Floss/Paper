'use strict';

const barcodes = require('../../kernel/barcodes');

// ---------------------------------------------------------------------------
// The challan core: a delivery, reception or internal-use challan from draft to
// issued to cancelled.
//
//   reading       list, one, lines, the DTOs, report-group codes
//   saving        saveDeliveryChallan: header, lines, linked orders, snapshots
//   issuing       issueDeliveryChallan: freezes the snapshot and moves stock.
//                 A reception mints material (mintReceivedMaterial); a delivery
//                 takes stock out; custody is recorded in the ledger
//   cancelling    cancelDeliveryChallan puts stock back; deleteDraftDeliveryChallan
//                 removes a draft
//   settling      the helpers the in-use reconcile uses to find and complete the
//                 order a challan was for
//
// Every one of save, issue, cancel and delete opens its own transaction.
//
// Stock is asked of the modules that own it. The movement ledger, minted
// materials and their positions go through inventoryPorts (receipts.*,
// movements.recordForChallan / forChallan / recordChallanReversal); the item's
// variation stock goes through the items port (itemStock.assertLeaf /
// applyDelta). What stock DOES is unchanged and pinned row by row in
// challan-stock-rows.test.js: issue and cancel write their own ledger rows and
// adjust variation stock, while deleting an issued reception goes through the
// general movement engine (inventoryPorts.movements.applyCore).
// Still written here by hand: piece_barcodes, which is production's table.
//
// Takes {get, all, run} and, by name, what it needs from around it: vendors,
// orders (row and lifecycle), the company profile, the template snapshot
// (modules/challans/templates.js), the inventory port, the custody ledger, and
// items helpers that are still defined in server.js.
// ---------------------------------------------------------------------------

function createChallanService({
  get,
  all,
  run,
  logChange,
  parseJson,
  parseJsonOrArray,
  parseJsonObject,
  normalizeCustomVariationValues,
  rowToUploadedAssetDto,
  itemStock,
  getVendorRowById,
  getOrderRowById,
  updateOrderLifecycle,
  rowToCompanyProfileDto,
  getActiveCompanyProfile,
  normalizeChallanType,
  buildChallanTemplateSnapshot,
  findActiveChallanTemplateForChallan,
  getItemSelectionSnapshot,
  getProductionRunRowById,
  inventoryPorts,
  runInputsForChallanLines,
  productionRunSource,
  recordLedgerEvent,
}) {
  const DELIVERY_CHALLAN_STATUSES = new Set(['draft', 'issued', 'cancelled']);

  async function getDeliveryChallanItems(challanId) {
    const items = await all(
      `
      SELECT *
      FROM delivery_challan_items
      WHERE challan_id = ?
      ORDER BY line_no ASC, id ASC
      `,
      [challanId],
    );
  
    if (items.length > 0) {
      const itemIds = items.map(item => item.id);
      const barcodes = await all(
        `SELECT * FROM piece_barcodes WHERE challan_item_id IN (${itemIds.join(',')})`
      );
    
      for (const item of items) {
        item.piece_barcodes = barcodes.filter(b => b.challan_item_id === item.id).map(b => ({
          id: b.id,
          challanItemId: b.challan_item_id,
          parentCode: b.parent_code,
          childCode: b.child_code,
          weight: Number(b.weight || 0),
        }));
      }
    }
    return items;
  }

  async function getDeliveryChallanOrderIds(challanId) {
    const rows = await all(
      `
      SELECT order_id
      FROM delivery_challan_order_items
      WHERE challan_id = ?
      ORDER BY order_id ASC
      `,
      [challanId],
    );
    return rows
      .map((row) => Number(row.order_id || 0))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  function normalizeReportGroupCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '-')
      .replace(/[^A-Z0-9_-]/g, '');
  }

  function normalizeReportGroupCodes(values = []) {
    const candidates = Array.isArray(values) ? values : [];
    return [
      ...new Set(
        candidates
          .map(normalizeReportGroupCode)
          .filter(Boolean),
      ),
    ].sort();
  }

  function deriveReportGroupCodesFromOrderIds(orderIds = []) {
    const normalizedOrderIds = [
      ...new Set(
        orderIds
          .map((value) => Number(value || 0))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ].sort((a, b) => a - b);
    if (normalizedOrderIds.length === 0) {
      return [];
    }
    if (normalizedOrderIds.length === 1) {
      return [`ORD-${normalizedOrderIds[0]}`];
    }
    return [`ORDSET-${normalizedOrderIds.join('-')}`];
  }

  async function getDeliveryChallanReportGroupCodes(challanId) {
    const rows = await all(
      `
      SELECT report_group_code
      FROM delivery_challan_report_groups
      WHERE challan_id = ?
      ORDER BY report_group_code ASC
      `,
      [challanId],
    );
    return rows
      .map((row) => normalizeReportGroupCode(row.report_group_code))
      .filter(Boolean);
  }

  async function effectiveReportGroupCodesForChallan(row, orderIds = null) {
    const explicitCodes = await getDeliveryChallanReportGroupCodes(row.id);
    if (normalizeChallanType(row.type) !== 'delivery') {
      return explicitCodes;
    }
    const linkedOrderIds = orderIds || await getDeliveryChallanOrderIds(row.id);
    const fallbackOrderIds = linkedOrderIds.length > 0
      ? linkedOrderIds
      : [Number(row.order_id || 0)].filter((value) => value > 0);
    return [
      ...new Set([
        ...explicitCodes,
        ...deriveReportGroupCodesFromOrderIds(fallbackOrderIds),
      ]),
    ].sort();
  }

  async function replaceChallanReportGroups(challanId, codes = []) {
    const now = new Date().toISOString();
    const normalizedCodes = normalizeReportGroupCodes(codes);
    await run('DELETE FROM delivery_challan_report_groups WHERE challan_id = ?', [challanId]);
    for (const code of normalizedCodes) {
      await run(
        `
        INSERT INTO report_groups (code, label, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET updated_at = excluded.updated_at
        `,
        [code, code, now, now],
      );
      await run(
        `
        INSERT OR IGNORE INTO delivery_challan_report_groups (
          challan_id, report_group_code, created_at
        ) VALUES (?, ?, ?)
        `,
        [challanId, code, now],
      );
    }
    return normalizedCodes;
  }

  async function getOrderRowsByIds(orderIds = []) {
    const normalizedOrderIds = [
      ...new Set(
        orderIds
          .map((value) => Number(value || 0))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ];
    if (normalizedOrderIds.length === 0) {
      return [];
    }
    const placeholders = normalizedOrderIds.map(() => '?').join(', ');
    return all(
      `
      SELECT o.*, c.gst_number AS client_gstin
      FROM order_items o
      LEFT JOIN clients c ON c.id = o.client_id
      WHERE o.id IN (${placeholders})
      ORDER BY datetime(o.created_at) DESC, o.id DESC
      `,
      normalizedOrderIds,
    );
  }

  function rowToDeliveryChallanItemDto(row) {
    const formatMeasure = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? String(numeric) : '';
    };
    return {
      id: row.id,
      challan_id: row.challan_id,
      order_item_id: row.order_item_id || null,
      production_run_id: row.production_run_id || null,
      item_id: row.item_id || null,
      variation_leaf_node_id: Number(row.variation_leaf_node_id || 0),
      line_no: Number(row.line_no || 0),
      particulars: row.particulars || '',
      hsn_code: row.hsn_code || '',
      note: row.note || '',
      variation_path_label: row.variation_path_label || '',
      variation_path_node_ids: parseJson(row.variation_path_node_ids_json, []),
      custom_variation_values: parseJson(row.custom_variation_values_json, {}),
      quantity_pcs: formatMeasure(row.quantity_pcs),
      weight: formatMeasure(row.weight),
      sheet_weights: parseJson(row.sheet_weights_json, []),
      piece_barcodes: row.piece_barcodes || [],
      // The material this line takes from: the lot a dispatch shipped, or the
      // received material a vendor return sends back.
      material_barcode: row.material_barcode || '',
      materialBarcode: row.material_barcode || '',
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    };
  }

  async function rowToDeliveryChallanDto(row, { includeItems = true } = {}) {
    const items = includeItems ? await getDeliveryChallanItems(row.id) : [];
  
    // Aggregates, so a list row can say something useful without carrying every
    // line. The list previously shipped the whole `items` array for every challan
    // — 26% of a 130 KB response, for challans nobody had opened.
    //
    // Pieces and weight are summed separately on purpose. These lines are mixed:
    // some are counted (`quantity_pcs`), some are weighed (`weight`), and adding
    // the two together would produce a number that is not a quantity of anything.
    let lineCount = 0;
    let totalQty = 0;
    let totalWeight = 0;
    if (includeItems) {
      lineCount = items.length;
      // Raw rows here, not DTOs — getDeliveryChallanItems is a SELECT *, so the
      // columns are snake_case. Reading `quantityPcs` off them silently summed
      // undefined to zero, which looks exactly like a challan of weighed goods.
      totalQty = items.reduce(
        (sum, item) => sum + Number(item.quantity_pcs ?? item.quantityPcs ?? 0),
        0,
      );
      totalWeight = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
    } else {
      const agg = await get(
        `SELECT COUNT(*) AS lineCount,
                COALESCE(SUM(quantity_pcs), 0) AS totalQty,
                COALESCE(SUM(weight), 0) AS totalWeight
         FROM delivery_challan_items WHERE challan_id = ?`,
        [row.id],
      );
      lineCount = Number(agg?.lineCount || 0);
      totalQty = Number(agg?.totalQty || 0);
      totalWeight = Number(agg?.totalWeight || 0);
    }

    let orderIds = await getDeliveryChallanOrderIds(row.id);
    if (orderIds.length === 0 && Number(row.order_id || 0) > 0) {
      orderIds = [Number(row.order_id || 0)];
    }
    const orderRows = await getOrderRowsByIds(orderIds);
    const orderNos = [
      ...new Set(
        orderRows
          .map((order) => String(order.order_no || '').trim())
        .filter(Boolean),
      ),
    ];
    const clientId = Number(orderRows[0]?.client_id || 0) || null;
    const reportGroupCodes = await effectiveReportGroupCodesForChallan(
      row,
      orderIds,
    );
  
    const assetRows = await all(
      "SELECT * FROM uploaded_assets WHERE entity_type = 'delivery_challan' AND entity_id = ? AND status = 'uploaded' ORDER BY created_at ASC",
      [row.id]
    );
    const assets = await Promise.all(assetRows.map(rowToUploadedAssetDto));

    const dto = {
      id: row.id,
      type: normalizeChallanType(row.type),
      purpose: row.purpose || 'trading',
      challanPurpose: row.purpose || 'trading',
      challan_purpose: row.purpose || 'trading',
      // Free-text purpose for internal challans (empty for delivery/reception).
      internal_purpose: row.internal_purpose || '',
      internalPurpose: row.internal_purpose || '',
      // Structured internal subtype (e.g. 'vendor_return').
      internal_subtype: row.internal_subtype || '',
      internalSubtype: row.internal_subtype || '',
      // The reception a vendor return sends stock back from, when it was made
      // by cancelling a partly used reception.
      source_reception_challan_id: Number(row.source_reception_challan_id || 0) || null,
      sourceReceptionChallanId: Number(row.source_reception_challan_id || 0) || null,
      // Per-line settlement breakdown once the challan has been reconciled
      // (scrap/leftover/lost/rejection/finished-goods); empty otherwise.
      reconciliation_json: row.reconciliation_json || '',
      reconciliationJson: row.reconciliation_json || '',
      order_id: row.order_id || null,
      order_ids: orderIds,
      report_group_codes: reportGroupCodes,
      reportGroupCodes: reportGroupCodes,
      order_no: row.order_no || '',
      order_nos: orderNos,
      client_id: clientId,
      challan_no: row.challan_no || '',
      date: row.date || '',
      location: row.location || '',
      customer_name: row.customer_name || '',
      customer_gstin: row.customer_gstin || '',
      vendor_id: row.vendor_id || null,
      vendor_name: row.vendor_name || '',
      vendor_gstin: row.vendor_gstin || '',
      material_owner_client_id: row.material_owner_client_id || null,
      material_owner_client_name: row.material_owner_client_name || '',
      material_owner_gstin: row.material_owner_gstin || '',
      source_reference: row.source_reference || '',
      poNumber: row.po_number || '',
      poDate: row.po_date || '',
      company_profile_snapshot: parseJsonObject(row.company_profile_snapshot, null),
      notes: row.notes || '',
      maintain_stocks: Number(row.maintain_stocks ?? 1) !== 0,
      used_in_report: Number(row.used_in_report ?? 0) !== 0,
      usedInReport: Number(row.used_in_report ?? 0) !== 0,
      status: row.status || 'draft',
      created_by: row.created_by || null,
      updated_by: row.updated_by || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      lineCount,
      // The name the client already parses (it falls back to `items.length`,
      // which is 0 once the array is gone). Sending it keeps the list row's
      // "3 items" label correct without a client change.
      itemsCount: lineCount,
      totalWeight,
      totalQty,
      ...(includeItems ? { items: items.map(rowToDeliveryChallanItemDto) } : {}),
      items_count: Number(row.items_count || items.length || 0),
      assets: assets,
    };

    if (!includeItems) {
      // Fields no list row renders, dropped from the summary only — the detail
      // endpoint still carries every one of them, so the editor, the printable
      // document and the report generator are unaffected.
      //
      // Verified by diffing the response's keys against every `json['...']` the
      // Flutter model reads: these are never parsed, in either spelling. On a
      // real workspace they were 19% of the list payload — a company profile
      // snapshot and a reconciliation blob per challan, repeated a hundred times
      // for rows nobody had opened.
      for (const field of SUMMARY_OMITTED_CHALLAN_FIELDS) {
        delete dto[field];
      }
    }
    return dto;
  }

  /// Carried on a challan but never read by a list row.
  ///
  /// Kept as a named list rather than by omitting them at construction, so the
  /// full shape stays visible in one place and a new field is opt-out rather than
  /// accidentally dropped.
  const SUMMARY_OMITTED_CHALLAN_FIELDS = Object.freeze([
    'companyProfileSnapshot',
    'company_profile_snapshot',
    'reconciliationJson',
    'reconciliation_json',
    'materialOwnerClientId',
    'material_owner_client_id',
    'materialOwnerClientName',
    'material_owner_client_name',
    'materialOwnerGstin',
    'material_owner_gstin',
    'created_by',
    'updated_by',
  ]);

  async function generateChallanNumber(type = 'delivery') {
    const normalizedType = normalizeChallanType(type);
    const prefix = normalizedType === 'reception'
      ? 'RC'
      : (normalizedType === 'internal' ? 'IC' : 'DC');
    const row = await get(
      `
      SELECT challan_no
      FROM delivery_challans
      WHERE challan_no LIKE ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [`${prefix}-%`],
    );
    const match = String(row?.challan_no || '').match(/(\d+)$/);
    const next = match ? Number(match[1]) + 1 : 1;
    return `${prefix}-${String(next).padStart(5, '0')}`;
  }

  async function challanNumberWarning(challanNo, type = 'delivery') {
    const normalized = String(challanNo || '').trim().toUpperCase();
    const prefix = normalizeChallanType(type) === 'reception' ? 'RC' : 'DC';
    const match = normalized.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) {
      return null;
    }
    const manualSequence = Number(match[1]);
    const next = await generateChallanNumber(type);
    const nextMatch = next.match(/(\d+)$/);
    const nextSequence = nextMatch ? Number(nextMatch[1]) : 0;
    if (manualSequence > 0 && nextSequence > 0 && manualSequence < nextSequence) {
      return {
        code: 'manual_sequence_overlap',
        message: `Manual challan number ${challanNo} is inside the generated ${prefix} sequence. Suggested next number: ${next}.`,
        suggestedChallanNo: next,
      };
    }
    return null;
  }

  function normalizeChallanDate(value) {
    const input = String(value || '').trim();
    if (!input) {
      return new Date().toISOString().slice(0, 10);
    }
    if (Number.isNaN(Date.parse(input))) {
      const error = new Error('Invalid challan date.');
      error.statusCode = 400;
      throw error;
    }
    return input.slice(0, 10);
  }

  function normalizeDeliveryChallanMeasure(value, fieldName) {
    const input = String(value ?? '').trim();
    if (!input) {
      return 0;
    }
    const numeric = Number(input);
    if (!Number.isFinite(numeric) || numeric < 0) {
      const error = new Error(`Invalid ${fieldName}.`);
      error.statusCode = 400;
      throw error;
    }
    return numeric;
  }

  // Per-sheet weight breakdown for purchase intake. Returns a sanitized array of
  // non-negative numbers. When present, it must sum to the line weight (the
  // factory's total-in = total-out invariant); otherwise a 400 is thrown. An
  // empty array is allowed for callers that don't track sheets (back-compat).
  function normalizeChallanSheetWeights(item, itemWeight) {
    const raw = item.sheetWeights ?? item.sheet_weights ?? [];
    if (!Array.isArray(raw) || raw.length === 0) {
      return [];
    }
    const weights = raw.map((value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        const error = new Error('Invalid sheet weight.');
        error.statusCode = 400;
        throw error;
      }
      return numeric;
    });
    const sum = weights.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - itemWeight) > 0.01) {
      const error = new Error(
        `Sheet weights must sum to the line weight (got ${sum}, expected ${itemWeight}).`,
      );
      error.statusCode = 400;
      throw error;
    }
    return weights;
  }

  function normalizeDeliveryChallanItems(items = []) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item, index) => ({
        orderItemId: Number(item.orderItemId ?? item.order_item_id ?? 0) || null,
        productionRunId: Number(item.productionRunId ?? item.production_run_id ?? 0) || null,
        itemId: Number(item.itemId ?? item.item_id ?? 0) || null,
        variationLeafNodeId:
          Number(item.variationLeafNodeId ?? item.variation_leaf_node_id ?? 0) || 0,
        lineNo: Number(item.lineNo ?? item.line_no ?? index + 1) || index + 1,
        particulars: String(item.particulars || '').trim(),
        hsnCode: String(item.hsnCode ?? item.hsn_code ?? '').trim(),
        note: String(item.note ?? item.lineNote ?? item.line_note ?? '').trim(),
        variationPathLabel: String(
          item.variationPathLabel ?? item.variation_path_label ?? '',
        ).trim(),
        variationPathNodeIds: parseJsonOrArray(
          item.variationPathNodeIds ?? item.variation_path_node_ids ?? item.variation_path_node_ids_json,
          [],
        )
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id !== 0),
        customVariationValues: normalizeCustomVariationValues(
          item.customVariationValues ?? item.custom_variation_values ?? item.custom_variation_values_json ?? {},
        ),
        quantityPcs: String(item.quantityPcs ?? item.quantity_pcs ?? '').trim(),
        weight: String(item.weight || '').trim(),
        materialBarcode: String(item.materialBarcode ?? item.material_barcode ?? '').trim(),
      }))
      .filter(
        (item) =>
          item.particulars ||
          item.hsnCode ||
          item.note ||
          item.quantityPcs ||
          item.weight ||
          item.orderItemId ||
          item.productionRunId ||
          item.itemId,
      )
      .map((item, index) => ({ ...item, lineNo: index + 1 }));
  }

  async function getDeliveryChallanRowById(id) {
    return get('SELECT * FROM delivery_challans WHERE id = ?', [Number(id)]);
  }

  async function listDeliveryChallans({
    status,
    type,
    search,
    dateFrom,
    dateTo,
    orderId,
    vendorId,
    itemId,
    variationLeafNodeId,
    createdBy,
  } = {}) {
    const where = [];
    const params = [];
    const normalizedType = type ? normalizeChallanType(type, '') : '';
    if (normalizedType) {
      where.push('dc.type = ?');
      params.push(normalizedType);
    }
    // Item filter — only challans whose lines reference this item. Combines with
    // every other filter via AND.
    const normalizedItemId = Number(itemId || 0);
    const normalizedVariationLeafNodeId = Number(variationLeafNodeId || 0);
    if (
      (Number.isInteger(normalizedItemId) && normalizedItemId > 0) ||
      (Number.isInteger(normalizedVariationLeafNodeId) &&
        normalizedVariationLeafNodeId > 0)
    ) {
      const lineFilters = [];
      if (Number.isInteger(normalizedItemId) && normalizedItemId > 0) {
        lineFilters.push('dci_item.item_id = ?');
        params.push(normalizedItemId);
      }
      if (
        Number.isInteger(normalizedVariationLeafNodeId) &&
        normalizedVariationLeafNodeId > 0
      ) {
        lineFilters.push('dci_item.variation_leaf_node_id = ?');
        params.push(normalizedVariationLeafNodeId);
      }
      where.push(`
        EXISTS (
          SELECT 1
          FROM delivery_challan_items dci_item
          WHERE dci_item.challan_id = dc.id
            AND ${lineFilters.join(' AND ')}
        )
      `);
    }
    const normalizedOrderId = Number(orderId || 0);
    if (Number.isInteger(normalizedOrderId) && normalizedOrderId > 0) {
      where.push(`
        (
          dc.order_id = ?
          OR EXISTS (
            SELECT 1
            FROM delivery_challan_order_items dco
            WHERE dco.challan_id = dc.id
              AND dco.order_id = ?
          )
        )
      `);
      params.push(normalizedOrderId);
      params.push(normalizedOrderId);
    }
    const normalizedVendorId = Number(vendorId || 0);
    if (Number.isInteger(normalizedVendorId) && normalizedVendorId > 0) {
      where.push('dc.vendor_id = ?');
      params.push(normalizedVendorId);
    }
    // Challan Book: only challans this user created.
    const normalizedCreatedBy = Number(createdBy || 0);
    if (Number.isInteger(normalizedCreatedBy) && normalizedCreatedBy > 0) {
      where.push('dc.created_by = ?');
      params.push(normalizedCreatedBy);
    }
    if (status && DELIVERY_CHALLAN_STATUSES.has(status)) {
      where.push('dc.status = ?');
      params.push(status);
    }
    const normalizedSearch = String(search || '').trim().toLowerCase();
    if (normalizedSearch) {
      where.push(`
        (
          LOWER(dc.challan_no) LIKE ?
          OR LOWER(dc.order_no) LIKE ?
          OR LOWER(dc.customer_name) LIKE ?
          OR LOWER(dc.vendor_name) LIKE ?
          OR LOWER(dc.source_reference) LIKE ?
        )
      `);
      params.push(
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
      );
    }
    if (dateFrom) {
      where.push('date(dc.date) >= date(?)');
      params.push(String(dateFrom).slice(0, 10));
    }
    if (dateTo) {
      where.push('date(dc.date) <= date(?)');
      params.push(String(dateTo).slice(0, 10));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await all(
      `
      SELECT dc.*, COUNT(dci.id) AS items_count
      FROM delivery_challans dc
      LEFT JOIN delivery_challan_items dci ON dci.challan_id = dc.id
      ${whereSql}
      GROUP BY dc.id
      ORDER BY date(dc.date) DESC, dc.id DESC
      `,
      params,
    );
    return Promise.all(rows.map((row) => rowToDeliveryChallanDto(row, { includeItems: false })));
  }

  async function getOrderForDeliveryChallan(orderId) {
    const order = await get(
      `
      SELECT o.*, c.gst_number AS client_gstin
      FROM order_items o
      LEFT JOIN clients c ON c.id = o.client_id
      WHERE o.id = ?
      `,
      [Number(orderId)],
    );
    if (!order) {
      const error = new Error('Order not found.');
      error.statusCode = 404;
      throw error;
    }
    return order;
  }

  function normalizeDeliveryChallanOrderIds(input = {}, existing = null) {
    const candidates = Array.isArray(input.orderIds)
      ? input.orderIds
      : Array.isArray(input.order_ids)
      ? input.order_ids
      : [];
    const normalized = [
      ...new Set(
        candidates
          .map((value) => Number(value || 0))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ];
    const legacyOrderId = Number(
      input.orderId ?? input.order_id ?? existing?.order_id ?? 0,
    );
    if (normalized.length === 0 && Number.isInteger(legacyOrderId) && legacyOrderId > 0) {
      return [legacyOrderId];
    }
    return normalized;
  }

  async function getOrdersForDeliveryChallan(orderIds) {
    const orders = await getOrderRowsByIds(orderIds);
    if (orders.length !== orderIds.length) {
      const error = new Error('One or more selected orders could not be found.');
      error.statusCode = 404;
      throw error;
    }
    const uniqueClientIds = [...new Set(orders.map((order) => Number(order.client_id || 0)))];
    if (uniqueClientIds.length !== 1) {
      const error = new Error('Delivery challans can only include orders from the same client.');
      error.statusCode = 400;
      throw error;
    }
    return orders;
  }

  function orderItemSnapshotFromOrder(order) {
    const variationLabel = String(order.variation_path_label || '').trim();
    const itemName = String(order.item_name || '').trim();
    return {
      orderItemId: Number(order.id),
      itemId: order.item_id || null,
      variationLeafNodeId: Number(order.variation_leaf_node_id || 0),
      variationPathLabel: variationLabel,
      particulars: variationLabel ? `${itemName} - ${variationLabel}` : itemName,
      hsnCode: '',
    };
  }

  async function getVendorForChallan(vendorId) {
    const vendor = await getVendorRowById(Number(vendorId));
    if (!vendor || vendor.is_archived) {
      const error = new Error('Select an active vendor before saving reception challan.');
      error.statusCode = 400;
      throw error;
    }
    return vendor;
  }

  async function validateProductionRunForChallanLine(runId, item) {
    if (!runId) {
      return null;
    }
    const run = await getProductionRunRowById(runId);
    if (!run || run.status !== 'completed') {
      const error = new Error('Selected production run is not completed or no longer exists.');
      error.statusCode = 400;
      throw error;
    }
    if (Number(run.item_id || 0) !== Number(item.itemId || 0)) {
      const error = new Error('Selected production run item does not match the challan line item.');
      error.statusCode = 400;
      throw error;
    }
    if (Number(run.variation_leaf_node_id || 0) !== Number(item.variationLeafNodeId || 0)) {
      const error = new Error('Selected production run variation does not match the challan line variation.');
      error.statusCode = 400;
      throw error;
    }
    return run;
  }

  async function logDeliveryChallanActivity(challanId, activityType, actor, details = {}) {
    await run(
      `
      INSERT INTO delivery_challan_activity_log (
        challan_id, activity_type, actor_user_id, actor_name, actor_role, details_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        challanId,
        activityType,
        actor?.id || null,
        actor?.name || 'System',
        actor?.role || 'system',
        JSON.stringify(details || {}),
        new Date().toISOString(),
      ],
    );
  }

  function assertCanChangeIssuedChallanNo(req, existing, nextChallanNo) {
    if (existing.status !== 'issued' || existing.challan_no === nextChallanNo) {
      return;
    }
    if (req.user?.role === 'super_admin' || req.user?.role === 'admin') {
      return;
    }
    const error = new Error('Issued challan numbers can only be changed by an admin.');
    error.statusCode = 403;
    throw error;
  }

  async function saveDeliveryChallan(input = {}, actor = null, req = null) {
    const id = Number(input.id || 0);
    const existing = id ? await getDeliveryChallanRowById(id) : null;
    if (id && !existing) {
      const error = new Error('Delivery challan not found.');
      error.statusCode = 404;
      throw error;
    }
    if (existing && existing.status !== 'draft') {
      const error = new Error('Only draft challans can be edited.');
      error.statusCode = 400;
      throw error;
    }

    const challanType = normalizeChallanType(
      input.type ?? input.challanType ?? input.challan_type ?? existing?.type ?? 'delivery',
    );
    const orderIds = challanType === 'delivery'
      ? normalizeDeliveryChallanOrderIds(input, existing)
      : [];
    const vendorId = Number(input.vendorId ?? input.vendor_id ?? existing?.vendor_id ?? 0);
    const maintainStocksInput = input.maintainStocks ?? input.maintain_stocks;
    const maintainStocks = maintainStocksInput === undefined
      ? Number(existing?.maintain_stocks ?? 1) !== 0
      : !(
        maintainStocksInput === false ||
        Number(maintainStocksInput) === 0
      );
    const location = String(input.location ?? existing?.location ?? '').trim() || 'MAIN';
    const sourceReference = String(
      input.sourceReference ?? input.source_reference ?? existing?.source_reference ?? '',
    ).trim();
    const poNumber = String(
      input.poNumber ?? input.po_number ?? existing?.po_number ?? '',
    ).trim();
    const poDate = String(
      input.poDate ?? input.po_date ?? existing?.po_date ?? '',
    ).trim();
    let orders = [];
    let firstOrder = null;
    let orderSnapshotsById = new Map();
    let vendor = null;
    if (challanType === 'delivery') {
      if (maintainStocks && orderIds.length == 0) {
        const error = new Error('Select at least one order before saving delivery challan.');
        error.statusCode = 400;
        throw error;
      }
      if (orderIds.length > 0) {
        orders = await getOrdersForDeliveryChallan(orderIds);
        firstOrder = orders[0] || null;
        orderSnapshotsById = new Map(
          orders.map((order) => [Number(order.id), orderItemSnapshotFromOrder(order)]),
        );
      }
    } else if (challanType === 'internal') {
      // Internal movements (production consumption / transfers) belong to no
      // external party, so neither an order nor a vendor is required. A vendor
      // may still be linked optionally if the caller supplies one.
      if (Number.isInteger(vendorId) && vendorId > 0) {
        vendor = await getVendorForChallan(vendorId);
      }
    } else {
      if (maintainStocks && (!Number.isInteger(vendorId) || vendorId <= 0)) {
        const error = new Error('Select a vendor before saving reception challan.');
        error.statusCode = 400;
        throw error;
      }
      if (Number.isInteger(vendorId) && vendorId > 0) {
        vendor = await getVendorForChallan(vendorId);
      }
    }
    const requestedChallanNo = String(
      input.challanNo ?? input.challan_no ?? '',
    ).trim();
    const challanNo = requestedChallanNo || await generateChallanNumber(challanType);
    const duplicate = await get(
      'SELECT id FROM delivery_challans WHERE LOWER(TRIM(challan_no)) = LOWER(TRIM(?)) AND id != ?',
      [challanNo, id || 0],
    );
    if (duplicate) {
      const error = new Error(`Challan number [${challanNo}] is already in use.`);
      error.statusCode = 409;
      throw error;
    }

    const date = normalizeChallanDate(input.date ?? existing?.date);
    const inputPurpose = String(
      input.purpose ?? input.challanPurpose ?? input.challan_purpose ?? existing?.purpose ?? 'trading',
    ).trim();
    const purpose = ['trading', 'manufacturing', 'jobWork'].includes(inputPurpose)
      ? inputPurpose
      : (inputPurpose === 'job_work' ? 'jobWork' : 'trading');
    // Free-text purpose for internal challans (kept separate from the enum
    // `purpose` above so delivery/reception behaviour is untouched).
    const internalPurpose = String(
      input.internalPurpose ?? input.internal_purpose ?? existing?.internal_purpose ?? '',
    ).trim();
    // Structured internal subtype (e.g. 'vendor_return') + the scanned sheet codes
    // a vendor-return carries (used at issue time to flag those sheets returned).
    const internalSubtype = String(
      input.internalSubtype ?? input.internal_subtype ?? existing?.internal_subtype ?? '',
    ).trim();
    const returnedSheetCodesInput =
      input.returnedSheetCodes ?? input.returned_sheet_codes ?? null;
    const returnedSheetCodesJson = Array.isArray(returnedSheetCodesInput)
      ? JSON.stringify(returnedSheetCodesInput.map((c) => String(c).trim()).filter(Boolean))
      : (existing?.returned_sheet_codes_json ?? '[]');
    const customerName = challanType === 'delivery'
      ? (maintainStocks
        ? String(firstOrder?.client_name || '').trim()
        : String(input.customerName ?? input.customer_name ?? existing?.customer_name ?? '').trim())
      : '';
    const customerGstin = challanType === 'delivery'
      ? (maintainStocks
        ? String(firstOrder?.client_gstin || '').trim()
        : String(input.customerGstin ?? input.customer_gstin ?? existing?.customer_gstin ?? '').trim())
      : '';
    const materialOwnerClientId = challanType === 'reception'
      ? Number(
        input.materialOwnerClientId ??
        input.material_owner_client_id ??
        existing?.material_owner_client_id ??
        0,
      )
      : 0;
    const materialOwnerClientName = challanType === 'reception'
      ? String(
        input.materialOwnerClientName ??
        input.material_owner_client_name ??
        existing?.material_owner_client_name ??
        '',
      ).trim()
      : '';
    const materialOwnerGstin = challanType === 'reception'
      ? String(
        input.materialOwnerGstin ??
        input.material_owner_gstin ??
        existing?.material_owner_gstin ??
        '',
      ).trim()
      : '';
    // A vendor return is an internal challan, but it goes to a vendor, so it
    // keeps the vendor the way a reception does.
    const isVendorReturn = challanType === 'internal' && internalSubtype === 'vendor_return';
    let sourceReceptionChallanId = isVendorReturn
      ? (Number(
        input.sourceReceptionChallanId ??
        input.source_reception_challan_id ??
        existing?.source_reception_challan_id ??
        0,
      ) || null)
      : null;
    // A return of scanned vendor sheets does not say which reception it sends
    // back to, but the sheets do: each was tagged on a reception line. When
    // they all came in on one reception, the return is tied to it, so issuing
    // takes the stock off that reception's own material.
    if (isVendorReturn && !sourceReceptionChallanId) {
      const codes = parseJsonOrArray(returnedSheetCodesJson, []);
      if (codes.length > 0) {
        const marks = codes.map(() => '?').join(',');
        const receptions = await all(
          `SELECT DISTINCT ci.challan_id
             FROM piece_barcodes pb
             JOIN delivery_challan_items ci ON ci.id = pb.challan_item_id
            WHERE pb.parent_code IN (${marks}) OR pb.child_code IN (${marks})`,
          [...codes, ...codes],
        );
        if (receptions.length === 1) {
          sourceReceptionChallanId = Number(receptions[0].challan_id) || null;
        }
      }
    }
    const vendorName = isVendorReturn
      ? String(vendor?.name || input.vendorName || input.vendor_name || existing?.vendor_name || '').trim()
      : challanType === 'reception'
      ? (maintainStocks
        ? String(vendor?.name || '').trim()
        : String(input.vendorName ?? input.vendor_name ?? input.customerName ?? input.customer_name ?? existing?.vendor_name ?? '').trim())
      : '';
    const vendorGstin = isVendorReturn
      ? String(vendor?.gst_number || input.vendorGstin || input.vendor_gstin || existing?.vendor_gstin || '').trim()
      : challanType === 'reception'
      ? (maintainStocks
        ? String(vendor?.gst_number || '').trim()
        : String(input.vendorGstin ?? input.vendor_gstin ?? input.customerGstin ?? input.customer_gstin ?? existing?.vendor_gstin ?? '').trim())
      : '';
    const orderNo = challanType === 'delivery'
      ? [...new Set(orders.map((order) => String(order.order_no || '').trim()).filter(Boolean))].join(', ')
      // On-demand procurement (Scenario B): a reception challan may name the client
      // order it was procured for, so the vendor sheets tie back to that order.
      : String(input.orderNo ?? input.order_no ?? existing?.order_no ?? '').trim();
    const notes = String(input.notes ?? existing?.notes ?? '').trim();
    const persistedOrderId = challanType === 'delivery' && maintainStocks ? (orderIds[0] || null) : null;
    const persistedVendorId = (isVendorReturn || (challanType === 'reception' && maintainStocks)) && vendor
      ? vendor.id
      : null;
    const normalizedItems = normalizeDeliveryChallanItems(input.items || []);
    const items = [];
    for (const item of normalizedItems) {
      if (!maintainStocks) {
        items.push({
          ...item,
          orderItemId: null,
          productionRunId: null,
          itemId: null,
          variationLeafNodeId: 0,
          particulars: item.particulars,
          variationPathLabel: item.variationPathLabel,
          hsnCode: item.hsnCode,
        });
      } else if (challanType === 'delivery') {
        if (item.productionRunId) {
          const snapshot = await getItemSelectionSnapshot(item.itemId, item.variationLeafNodeId);
          const run = await validateProductionRunForChallanLine(item.productionRunId, {
            itemId: snapshot.itemId,
            variationLeafNodeId: snapshot.variationLeafNodeId,
          });
          items.push({
            ...item,
            orderItemId: item.orderItemId || null,
            productionRunId: run.id,
            itemId: snapshot.itemId,
            variationLeafNodeId: snapshot.variationLeafNodeId,
            particulars: item.particulars || snapshot.particulars,
            variationPathLabel: item.variationPathLabel || snapshot.variationPathLabel,
            variationPathNodeIds: item.variationPathNodeIds?.length
              ? item.variationPathNodeIds
              : snapshot.variationPathNodeIds,
            hsnCode: item.hsnCode,
          });
          continue;
        }
        const orderItemId = Number(item.orderItemId || 0);
        if (!Number.isInteger(orderItemId) || orderItemId <= 0) {
          const error = new Error('Each delivery challan row must reference one of the selected order_items.');
          error.statusCode = 400;
          throw error;
        }
        const selectedOrder = orders.find((order) => Number(order.id) === orderItemId);
        if (!selectedOrder) {
          const error = new Error('Selected challan item does not belong to the selected order.');
          error.statusCode = 400;
          throw error;
        }
        const orderSnapshot = orderSnapshotsById.get(orderItemId);
        const itemId = item.itemId || selectedOrder.item_id || null;
        if (itemId && Number(itemId) !== Number(selectedOrder.item_id || 0)) {
          const error = new Error('Selected challan item does not match the selected order item.');
          error.statusCode = 400;
          throw error;
        }
        const requestedVariationLeafNodeId = Number(item.variationLeafNodeId || 0);
        const orderVariationLeafNodeId = Number(
          orderSnapshot?.variationLeafNodeId || 0,
        );
        if (
          requestedVariationLeafNodeId > 0 &&
          requestedVariationLeafNodeId !== orderVariationLeafNodeId
        ) {
          const error = new Error('Selected challan variation does not match the selected order item.');
          error.statusCode = 400;
          throw error;
        }
        items.push({
          ...item,
          orderItemId,
          productionRunId: null,
          itemId,
          variationLeafNodeId: orderVariationLeafNodeId,
          particulars: orderSnapshot?.particulars || item.particulars,
          variationPathLabel: orderSnapshot?.variationPathLabel || item.variationPathLabel,
          variationPathNodeIds: orderSnapshot?.variationPathNodeIds || item.variationPathNodeIds || [],
          customVariationValues: orderSnapshot?.customVariationValues || item.customVariationValues || {},
          hsnCode: orderSnapshot?.hsnCode || item.hsnCode,
        });
      } else {
        if (!Number.isInteger(item.itemId) || item.itemId <= 0) {
          const error = new Error('Each reception challan row must select an item.');
          error.statusCode = 400;
          throw error;
        }
        const snapshot = await getItemSelectionSnapshot(item.itemId, item.variationLeafNodeId);
        items.push({
          ...item,
          orderItemId: null,
          itemId: snapshot.itemId,
          variationLeafNodeId: snapshot.variationLeafNodeId,
          particulars: item.particulars || snapshot.particulars,
          variationPathLabel: item.variationPathLabel || snapshot.variationPathLabel,
          variationPathNodeIds: item.variationPathNodeIds?.length
            ? item.variationPathNodeIds
            : snapshot.variationPathNodeIds,
          hsnCode: item.hsnCode,
        });
      }
    }
    // A return made from a reception sends back specific received material. A
    // line that does not say which (an older client re-saving the draft) gets
    // the reception's material for the same item and variation.
    if (sourceReceptionChallanId) {
      const received = await inventoryPorts.receipts.usageForChallan(sourceReceptionChallanId);
      for (const item of items) {
        if (item.materialBarcode) continue;
        const match = received.find(
          (entry) =>
            Number(entry.itemId || 0) === Number(item.itemId || 0) &&
            Number(entry.leafNodeId || 0) === Number(item.variationLeafNodeId || 0),
        );
        if (match) item.materialBarcode = match.barcode;
      }
    }
    const now = new Date().toISOString();

    await run('BEGIN TRANSACTION');
    try {
      let challanId = id;
      if (existing) {
        await run(
          `
          UPDATE delivery_challans
          SET type = ?, order_id = ?, order_no = ?, challan_no = ?, date = ?, location = ?,
              customer_name = ?, customer_gstin = ?, vendor_id = ?, vendor_name = ?, vendor_gstin = ?,
              material_owner_client_id = ?, material_owner_client_name = ?, material_owner_gstin = ?,
              source_reference = ?, po_number = ?, po_date = ?, notes = ?, maintain_stocks = ?, purpose = ?, internal_purpose = ?, internal_subtype = ?, returned_sheet_codes_json = ?, updated_by = ?, updated_at = ?
          WHERE id = ?
          `,
          [
            challanType,
            persistedOrderId,
            orderNo,
            challanNo,
            date,
            location,
            customerName,
            customerGstin,
            persistedVendorId,
            vendorName,
            vendorGstin,
            materialOwnerClientId > 0 ? materialOwnerClientId : null,
            materialOwnerClientName,
            materialOwnerGstin,
            sourceReference,
            poNumber,
            poDate,
            notes,
            maintainStocks ? 1 : 0,
            purpose,
            internalPurpose,
            internalSubtype,
            returnedSheetCodesJson,
            actor?.id || null,
            now,
            challanId,
          ],
        );
        await run('DELETE FROM delivery_challan_items WHERE challan_id = ?', [challanId]);
        await run('DELETE FROM delivery_challan_order_items WHERE challan_id = ?', [challanId]);
      } else {
        const result = await run(
          `
          INSERT INTO delivery_challans (
            type, order_id, order_no, challan_no, date, location, customer_name, customer_gstin,
            vendor_id, vendor_name, vendor_gstin, material_owner_client_id, material_owner_client_name,
            material_owner_gstin, source_reference, po_number, po_date, notes, status,
            maintain_stocks, purpose, internal_purpose, internal_subtype, returned_sheet_codes_json, created_by, updated_by, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            challanType,
            persistedOrderId,
            orderNo,
            challanNo,
            date,
            location,
            customerName,
            customerGstin,
            persistedVendorId,
            vendorName,
            vendorGstin,
            materialOwnerClientId > 0 ? materialOwnerClientId : null,
            materialOwnerClientName,
            materialOwnerGstin,
            sourceReference,
            poNumber,
            poDate,
            notes,
            maintainStocks ? 1 : 0,
            purpose,
            internalPurpose,
            internalSubtype,
            returnedSheetCodesJson,
            actor?.id || null,
            actor?.id || null,
            now,
            now,
          ],
        );
        challanId = result.lastID;
      }
      await run(
        'UPDATE delivery_challans SET source_reception_challan_id = ? WHERE id = ?',
        [sourceReceptionChallanId, challanId],
      );

      if (challanType === 'delivery' && maintainStocks) {
        for (const orderId of orderIds) {
          await run(
            `
            INSERT INTO delivery_challan_order_items (challan_id, order_id, created_at)
            VALUES (?, ?, ?)
            `,
            [challanId, orderId, now],
          );
        }
      }

      const reportGroupInputProvided =
        Object.prototype.hasOwnProperty.call(input, 'reportGroupCodes') ||
        Object.prototype.hasOwnProperty.call(input, 'report_group_codes');
      let reportGroupCodes = [];
      if (challanType === 'delivery') {
        reportGroupCodes = deriveReportGroupCodesFromOrderIds(orderIds);
      } else if (reportGroupInputProvided) {
        reportGroupCodes = normalizeReportGroupCodes(
          input.reportGroupCodes ?? input.report_group_codes ?? [],
        );
      } else if (existing) {
        reportGroupCodes = await getDeliveryChallanReportGroupCodes(challanId);
      }
      await replaceChallanReportGroups(challanId, reportGroupCodes);

      const genericAssets = input.genericAssets ?? [];
      if (Array.isArray(genericAssets) && genericAssets.length > 0) {
        for (const asset of genericAssets) {
          if (!asset.objectKey || !asset.fileName || !asset.contentType) continue;
          await run(
            `
            INSERT OR IGNORE INTO uploaded_assets (
              entity_type, entity_id, file_name, content_type, size_bytes, sha256,
              object_key, status, is_primary, created_at, uploaded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', 0, ?, ?)
            `,
            [
              'delivery_challan',
              challanId,
              asset.fileName,
              asset.contentType,
              asset.sizeBytes || 0,
              asset.sha256 || '',
              asset.objectKey,
              now,
              now,
            ]
          );
        }
      }

      for (const item of items) {
        const itemWeight = normalizeDeliveryChallanMeasure(item.weight, 'challan weight');
        const sheetWeights = normalizeChallanSheetWeights(item, itemWeight);
        const itemResult = await run(
          `
          INSERT INTO delivery_challan_items (
            challan_id, order_item_id, production_run_id, item_id, variation_leaf_node_id,
            line_no, particulars, hsn_code, variation_path_label, variation_path_node_ids_json,
            note, quantity_pcs, weight, sheet_weights_json, custom_variation_values_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            challanId,
            item.orderItemId,
            item.productionRunId || null,
            item.itemId,
            item.variationLeafNodeId || 0,
            item.lineNo,
            item.particulars,
            item.hsnCode,
            item.variationPathLabel || '',
            JSON.stringify(item.variationPathNodeIds || []),
            item.note,
            normalizeDeliveryChallanMeasure(item.quantityPcs, 'challan quantity'),
            itemWeight,
            JSON.stringify(sheetWeights),
            JSON.stringify(item.customVariationValues || {}),
            now,
            now,
          ],
        );
      
        const newChallanItemId = itemResult.lastID;
        if (item.materialBarcode) {
          await run(
            'UPDATE delivery_challan_items SET material_barcode = ? WHERE id = ?',
            [item.materialBarcode, newChallanItemId],
          );
        }
      
        const pieceBarcodes = item.pieceBarcodes || item.piece_barcodes || [];
        for (const pb of pieceBarcodes) {
          if (pb.parentCode && pb.childCode) {
            await run(
              `INSERT INTO piece_barcodes (challan_item_id, parent_code, child_code, created_at) VALUES (?, ?, ?, ?)`,
              [newChallanItemId, pb.parentCode, pb.childCode, now]
            );
          }
        }
      }

      await logDeliveryChallanActivity(challanId, existing ? 'challan_edited' : 'challan_created', actor, {
        challanNo,
        type: challanType,
        itemCount: items.length,
      });
      const saved = await getDeliveryChallanRowById(challanId);
      await logChange('delivery_challans', challanId, existing ? 'UPDATE' : 'INSERT');
      await run('COMMIT');
      return saved;
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  /// Issues a challan: moves stock, mints materials, and records custody.
  ///
  /// `recordCustody` exists for the demo and scenario seeders. They call this to
  /// build a plausible-looking workspace, and every such call was writing real
  /// custody events for invented history into `barcode_ledger` — a table whose
  /// triggers forbid UPDATE and DELETE, so a reseed permanently mixed fiction into
  /// the one record that is supposed to be trustworthy. A trail you cannot trust
  /// is worse than no trail, because people act on it.
  async function issueDeliveryChallan(id, actor = null, { recordCustody = true } = {}) {
    const existing = await getDeliveryChallanRowById(id);
    if (!existing) {
      const error = new Error('Delivery challan not found.');
      error.statusCode = 404;
      throw error;
    }
    if (existing.status === 'cancelled') {
      const error = new Error('Cancelled challans cannot be issued.');
      error.statusCode = 400;
      throw error;
    }

    const maintainStocks = Number(existing.maintain_stocks ?? 1) !== 0;
    if (maintainStocks && normalizeChallanType(existing.type) === 'delivery') {
      const orderIds = await getDeliveryChallanOrderIds(id);
      if (orderIds.length === 0 && !existing.order_id) {
        const error = new Error('Select at least one order before issuing challan.');
        error.statusCode = 400;
        throw error;
      }
    }
    if (maintainStocks && normalizeChallanType(existing.type) === 'delivery' && !String(existing.customer_name || '').trim()) {
      const error = new Error('Customer name is required before issuing challan.');
      error.statusCode = 400;
      throw error;
    }
    if (maintainStocks && normalizeChallanType(existing.type) === 'reception' && !existing.vendor_id) {
      const error = new Error('Vendor is required before issuing reception challan.');
      error.statusCode = 400;
      throw error;
    }
    const items = await getDeliveryChallanItems(id);
    if (items.length === 0) {
      const error = new Error('Add at least one line item before issuing challan.');
      error.statusCode = 400;
      throw error;
    }
    for (const item of items) {
      if (maintainStocks && !item.order_item_id && !item.item_id) {
        const error = new Error('Each challan item must reference an order item.');
        error.statusCode = 400;
        throw error;
      }
      if (!maintainStocks && !String(item.particulars || '').trim()) {
        const error = new Error('Enter item text and Qty / Pcs or Weight for each challan item before issuing.');
        error.statusCode = 400;
        throw error;
      }
      const quantity = Number(item.quantity_pcs);
      const weight = Number(item.weight);
      const hasQuantity = Number.isFinite(quantity) && quantity > 0;
      const hasWeight = Number.isFinite(weight) && weight > 0;
      if (!hasQuantity && !hasWeight) {
        const error = new Error('Enter Qty / Pcs or Weight for each challan item before issuing.');
        error.statusCode = 400;
        throw error;
      }
      if (maintainStocks && normalizeChallanType(existing.type) === 'delivery' && item.production_run_id) {
        await validateProductionRunForChallanLine(item.production_run_id, {
          itemId: item.item_id,
          variationLeafNodeId: item.variation_leaf_node_id,
        });
      }
    }
    const profile = rowToCompanyProfileDto(await getActiveCompanyProfile());
    const activeTemplate = await findActiveChallanTemplateForChallan(existing);
    const templateSnapshot = activeTemplate
      ? await buildChallanTemplateSnapshot(activeTemplate)
      : null;
    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      if (maintainStocks) for (const item of items) {
        const quantity = Number(item.quantity_pcs);
        const weight = Number(item.weight);
        const itemId = Number(item.item_id || 0);

        let isWeightUnit = false;
        let unitSymbol = 'pcs';
        if (itemId > 0) {
          const itemRow = await get(`
            SELECT u.symbol
            FROM items i
            JOIN units u ON i.unit_id = u.id
            WHERE i.id = ?
          `, [itemId]);
          if (itemRow) {
            unitSymbol = String(itemRow.symbol || '').trim().toLowerCase();
            isWeightUnit = ['kg', 'g', 'mg', 'ton', 'tons', 't', 'lbs', 'oz', 'weight'].includes(unitSymbol);
          }
        }

        let movementQty = 0;
        let movementUom = 'pcs';
        if (isWeightUnit) {
          // If the item is tracked by weight, prefer the weight field over quantity_pcs
          movementQty = Number.isFinite(weight) && weight > 0 ? weight : quantity;
          movementUom = unitSymbol;
        } else {
          // If it's a piece-tracked item, prefer quantity_pcs
          movementQty = Number.isFinite(quantity) && quantity > 0 ? quantity : weight;
          movementUom = unitSymbol || 'pcs';
        }

        console.log(`[Challan Debug] Item ID ${itemId} unit is '${unitSymbol}'. Input: Qty=${quantity}, Weight=${weight}. Resolved Movement: ${movementQty} ${movementUom}.`);

        const leafNodeId = Number(item.variation_leaf_node_id || 0);
        const locationId = String(existing.location || '').trim() || 'MAIN';
        const isReception = normalizeChallanType(existing.type) === 'reception';
        const movementType = isReception ? 'receive' : 'issue';
        if (itemId === 0) {
          const error = new Error('Each challan item must reference an item.');
          error.statusCode = 400;
          throw error;
        }
        await itemStock.assertLeaf(itemId, leafNodeId);

        // A vendor return made from a reception sends back that reception's own
        // material, so it leaves through the movement engine against the real
        // barcode: the stock position, the material's totals and the item's
        // stock all go down together. The plain outgoing path below names no
        // piece ('-') and would leave the received material untouched.
        const returnedBarcode = existing.source_reception_challan_id
          ? String(item.material_barcode || '').trim()
          : '';
        if (returnedBarcode) {
          await issueReturnLine({
            challan: existing,
            line: item,
            barcode: returnedBarcode,
            qty: movementQty,
            uom: movementUom,
            actor,
          });
          continue;
        }

        // Material arriving on a reception challan becomes a barcoded row in
        // `materials`, not just a number on `variation_stock`.
        //
        // Without this the two halves of the app counted different things:
        // challans moved "25 of this item, in this variation", production
        // consumed "this physical piece, by barcode". Received material was
        // therefore never assignable on the floor, and an order could never say
        // what went into it. The row carries the challan and the line it came in
        // on, so provenance is a column rather than a join through movements.
        const receivedBarcode = isReception
          ? await inventoryPorts.receipts.mintFromChallanLine({
              challan: existing,
              line: item,
              itemId,
              leafNodeId,
              quantity: movementQty,
              uom: movementUom,
              locationId,
              now,
            })
          : null;

        await inventoryPorts.movements.recordForChallan({
          // A real barcode for received material; '-' remains for a delivery,
          // which takes stock away rather than bringing a piece into being.
          materialBarcode: receivedBarcode || '-',
          movementType,
          qty: movementQty,
          uom: movementUom,
          locationId,
          reasonCode: isReception ? 'reception_challan_issue' : 'delivery_challan_issue',
          challanId: existing.id,
          challanType: normalizeChallanType(existing.type),
          challanLineId: item.id,
          actorName: actor?.name || 'System',
          now,
          itemId,
          leafNodeId,
        });

        // The custody event for this line.
        //
        // Written here rather than at the end of the transaction because this is
        // the only place that knows all of it at once: the barcode just minted,
        // the challan it came in on, the quantity, and who issued it. Reassembling
        // that afterwards from the rows would be guesswork.
        const challanCode = barcodes.encode(
          isReception ? 'RC' : 'DC',
          existing.challan_no,
        );
        if (recordCustody) {
          if (isReception) {
            // Per line, because each line mints its own material and the event is
            // that material's own beginning.
            await recordLedgerEvent({
              subjectBarcode: barcodes.encode('MAT', receivedBarcode || ''),
              eventType: 'INWARD_RECEIVED',
              actorName: actor?.name || 'System',
              // Built by hand before LOC was a real type, so it carried no check
              // character and resolved to nothing.
              locationBarcode: locationId ? barcodes.encode('LOC', locationId) : null,
              documentBarcode: challanCode,
              orderBarcode: existing.order_no
                ? barcodes.encode('ORD', existing.order_no)
                : null,
              // Where it came from. Recorded here because this is the only moment
              // that knows it; a vendor is not a second event at the same instant.
              parents: existing.vendor_id
                ? [barcodes.encode('VEN', existing.vendor_id)].filter(Boolean)
                : [],
              children: receivedBarcode ? [barcodes.encode('MAT', receivedBarcode)] : [],
              metrics: {
                qty: movementQty,
                unit: movementUom,
                itemId,
                variationLeafNodeId: leafNodeId || null,
                vendor: existing.vendor_name || '',
              },
              notes: String(item.particulars || ''),
            });
          }
          // A delivery writes nothing here. Its subject is the challan — the same
          // challan for every line — so a per-line emit wrote a twelve-line
          // consignment into the ledger twelve times, each row identical but for
          // its metrics. That is not twelve happenings, and an append-only table
          // cannot be de-duplicated afterwards. One event is written after the
          // loop instead.
        }

        const delta = isReception ? movementQty : -movementQty;
        await itemStock.applyDelta({
          itemId,
          variationLeafNodeId: leafNodeId,
          locationId,
          variationPathLabel: item.variation_path_label || item.variationPathLabel || item.particulars || '',
          variationPathNodeIds: parseJsonOrArray(
            item.variation_path_node_ids_json ?? item.variationPathNodeIds,
            [],
          ),
          customVariationValues: parseJsonOrArray(
            item.custom_variation_values_json ?? item.customVariationValues,
            {},
          ),
          delta,
          now,
        });
      }
      // Vendor-return challans: flag each scanned sheet as returned to its vendor,
      // rejecting a sheet that was already returned (double-return guard). Stock was
      // deducted by the loop above via the generic internal-challan issue path.
      if (String(existing.internal_subtype || '') === 'vendor_return') {
        let returnedCodes = [];
        try {
          returnedCodes = JSON.parse(existing.returned_sheet_codes_json || '[]');
        } catch (_) {
          returnedCodes = [];
        }
        for (const code of returnedCodes) {
          const sheet = await get(
            'SELECT id, returned_at FROM piece_barcodes WHERE parent_code = ? OR child_code = ?',
            [code, code],
          );
          if (!sheet) continue;
          if (sheet.returned_at) {
            const error = new Error(`Sheet ${code} has already been returned to the vendor.`);
            error.statusCode = 409;
            throw error;
          }
          await run(
            'UPDATE piece_barcodes SET returned_at = ?, returned_challan_id = ? WHERE id = ?',
            [now, id, sheet.id],
          );
        }
      }
      // The consignment leaving, as one event.
      //
      // Built from the challan's own lines rather than from the stock loop above,
      // because a document-only challan (maintain_stocks off) still dispatches
      // goods — it just does not track them. Custody is about who had the thing,
      // not about whether inventory was adjusted.
      const isDeliveryDispatch = normalizeChallanType(existing.type) !== 'reception';
      if (recordCustody && isDeliveryDispatch && items.length) {

        // What actually went out, named as things rather than as a class of goods.
        //
        // This is the hinge of the whole trail. Without it a dispatch records only
        // an item id and a variation, so scanning a delivered piece reaches "some
        // of this kind of thing" and stops — the run that made it, the material it
        // was cut from and the vendor it came from are all unreachable from the
        // customer end, which is the end complaints arrive at.
        //
        // `production_run_id` is already on the line, written at save and checked
        // by validateProductionRunForChallanLine above, so this is a link that was
        // sitting there unused. It is nullable, and a line without one is recorded
        // as such rather than guessed at.
        const dispatchParents = [];
        for (const line of items) {
          if (line.id) {
            const lineCode = barcodes.encode('DCL', line.id);
            if (lineCode) dispatchParents.push(lineCode);
          }
          if (!line.production_run_id) continue;
          const producedBy = await productionRunSource(line.production_run_id);
          const runCode = producedBy && barcodes.encode('MFG', producedBy.run_code);
          if (runCode) dispatchParents.push(runCode);

          // The specific lot, which is one hop further than the run.
          //
          // A run mints a lot every time it completes, so "made by run 42" does
          // not identify the physical thing in the customer's hands — and a
          // defect report starts by scanning that thing. Naming the lot is what
          // turns the trail from "some of this kind of goods" into "this piece".
          //
          // Two hops to find it: production_runs.source_metadata_json remembers
          // which pipeline run produced it, and minting the lot wrote an
          // inventory movement against that pipeline run. Derived rather than
          // chosen in the UI, so every challan line that already names a run gets
          // its lot without anyone re-entering anything.
          let lotCode = String(line.lot_code || '').trim();
          if (!lotCode) {
            const pipelineRunId = parseJsonOrArray(producedBy?.source_metadata_json, {})?.pipelineRunId;
            if (pipelineRunId) {
              lotCode = await inventoryPorts.movements.producedLotCodeForRun(pipelineRunId);
              if (lotCode) {
                // Written back, so which lot shipped is a recorded fact about this
                // dispatch rather than something re-derived later against data
                // that has moved on. The run may mint again tomorrow; this line
                // shipped this lot.
                await run(
                  'UPDATE delivery_challan_items SET lot_code = ?, material_barcode = ? WHERE id = ?',
                  [lotCode, lotCode, line.id],
                );
              }
            }
          }
          if (lotCode) {
            const lotBarcode = barcodes.encode('MAT', lotCode);
            if (lotBarcode) dispatchParents.push(lotBarcode);
            line.lot_code = lotCode;
          }
        }
        // Built after the loop, so a lot derived above is on the line it describes.
        const dispatchedLines = items.map((line) => ({
          particulars: String(line.particulars || ''),
          qty: Number(line.quantity_pcs || 0) || Number(line.weight || 0) || 0,
          itemId: line.item_id || null,
          variationLeafNodeId: line.variation_leaf_node_id || null,
          productionRunId: line.production_run_id || null,
          lotCode: String(line.lot_code || '') || null,
        }));

        const challanCode = barcodes.encode(
          normalizeChallanType(existing.type) === 'reception' ? 'RC' : 'DC',
          existing.challan_no,
        );
        await recordLedgerEvent({
          subjectBarcode: challanCode,
          eventType: 'DISPATCH_PACKED',
          actorName: actor?.name || 'System',
          documentBarcode: challanCode,
          orderBarcode: existing.order_no
            ? barcodes.encode('ORD', existing.order_no)
            : null,
          parents: dispatchParents,
          metrics: {
            lineCount: dispatchedLines.length,
            totalQty: dispatchedLines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
            // Stated rather than inferred from an empty list: "nothing was linked"
            // and "every line was linked" must not look the same to a reader.
            linesWithProductionRun: dispatchedLines.filter((line) => line.productionRunId).length,
            linesWithLot: dispatchedLines.filter((line) => line.lotCode).length,
            lines: dispatchedLines,
          },
          notes: existing.customer_name || '',
        });
      }
      await run(
        `
        UPDATE delivery_challans
        SET status = 'issued', company_profile_snapshot = ?, template_snapshot_json = ?,
            updated_by = ?, updated_at = ?
        WHERE id = ?
        `,
        [
          JSON.stringify(profile),
          templateSnapshot ? JSON.stringify(templateSnapshot) : null,
          actor?.id || null,
          now,
          id,
        ],
      );
      await logChange('delivery_challans', id, 'UPDATE');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    await logDeliveryChallanActivity(id, 'challan_issued', actor, {
      challanNo: existing.challan_no,
      type: normalizeChallanType(existing.type),
      companyProfileId: profile?.id || null,
    });
    return getDeliveryChallanRowById(id);
  }

  const WEIGHT_UOMS = new Set(['kg', 'g', 'mg', 'ton', 'tons', 't', 'lbs', 'oz', 'weight']);
  const QTY_EPSILON = 1e-9;

  /// How much of what a reception brought in is still free to cancel or send
  /// back. One entry per received material:
  /// `{ barcode, lineId, itemId, leafNodeId, uom, received, onHand, reserved,
  ///    onRuns, free, used, touched }`.
  ///
  /// Used means consumed, reserved, or claimed by a run. Inventory knows the
  /// first two from its positions. A run can also claim stock without a
  /// movement (a scanned vendor sheet, an issue by quantity, a material assigned
  /// with no quantity yet), and production says how much of that there is.
  async function receptionUsage(receptionId) {
    const entries = await inventoryPorts.receipts.usageForChallan(receptionId);
    const runRows = await runInputsForChallanLines(entries.map((entry) => entry.lineId));
    return entries.map((entry) => {
      const byWeight = WEIGHT_UOMS.has(String(entry.uom || '').toLowerCase());
      const available = Math.max(0, entry.onHand - entry.reserved);
      let onRuns = 0;
      for (const row of runRows) {
        if (Number(row.challan_item_id) !== Number(entry.lineId)) continue;
        if (row.source_kind === 'quantity') {
          onRuns += Number(row.qty || 0);
        } else if (row.source_kind === 'sheet') {
          // A sheet is weighed, so it counts by weight when the material is
          // kept by weight and as one piece each when it is counted.
          onRuns += byWeight ? Number(row.weight || 0) : Number(row.inputs || 0);
        } else {
          // Assigned to a run with no quantity: how much the run will take is
          // not known, so none of it is free.
          onRuns += available;
        }
      }
      const free = Math.max(0, available - onRuns);
      const used = Math.max(0, entry.received - free);
      return { ...entry, onRuns, free, used, touched: used > QTY_EPSILON };
    });
  }

  /// One line of a vendor return leaving stock, against the received material
  /// it names.
  async function issueReturnLine({
    challan, line, barcode, qty, uom, actor,
  }) {
    const usage = await receptionUsage(challan.source_reception_challan_id);
    const entry = usage.find((candidate) => candidate.barcode === barcode);
    if (!entry) {
      const error = new Error(`Material ${barcode} did not come in on the reception this return was made from.`);
      error.statusCode = 409;
      throw error;
    }
    if (qty > entry.free + QTY_EPSILON) {
      const error = new Error(
        `Only ${entry.free} ${uom} of ${barcode} are free to return; the rest is used or reserved.`,
      );
      error.statusCode = 409;
      error.code = 'return_exceeds_free_stock';
      throw error;
    }
    await inventoryPorts.movements.applyCore(
      {
        barcode,
        movementType: 'issue',
        qty,
        primaryQty: qty,
        uom,
        reasonCode: 'vendor_return_issue',
        referenceType: 'challan',
        referenceId: String(challan.id),
        sourceChallanId: challan.id,
        sourceChallanType: normalizeChallanType(challan.type),
        sourceChallanLineId: line.id,
        actor,
      },
      { useTransaction: false },
    );
  }

  /// The draft vendor return for what is still free of a partly used reception.
  /// While that draft is open a second cancel attempt gets it back, not a
  /// second one. A return of scanned sheets is a different thing and is not it.
  async function createReturnForReception(reception, usage, actor) {
    const open = await get(
      `SELECT * FROM delivery_challans
        WHERE source_reception_challan_id = ? AND status = 'draft'
          AND COALESCE(returned_sheet_codes_json, '[]') = '[]'
        ORDER BY id DESC LIMIT 1`,
      [reception.id],
    );
    if (open) return open;

    const receptionLines = await getDeliveryChallanItems(reception.id);
    const items = [];
    for (const entry of usage) {
      if (!(entry.free > QTY_EPSILON)) continue;
      const source = receptionLines.find((line) => Number(line.id) === Number(entry.lineId)) || {};
      const byWeight = WEIGHT_UOMS.has(String(entry.uom || '').toLowerCase());
      items.push({
        itemId: entry.itemId,
        variationLeafNodeId: entry.leafNodeId,
        particulars: source.particulars || '',
        hsnCode: source.hsn_code || '',
        variationPathLabel: source.variation_path_label || '',
        variationPathNodeIds: parseJsonOrArray(source.variation_path_node_ids_json, []),
        customVariationValues: parseJsonOrArray(source.custom_variation_values_json, {}),
        note: `Return of ${entry.barcode} from ${reception.challan_no}`,
        // The same rule issuing uses to read a line: a weighed item is read
        // from the weight, a counted one from the pieces.
        quantityPcs: byWeight ? '' : String(entry.free),
        weight: byWeight ? String(entry.free) : '',
        materialBarcode: entry.barcode,
      });
    }
    return saveDeliveryChallan(
      {
        type: 'internal',
        internalSubtype: 'vendor_return',
        internalPurpose: 'Vendor return',
        sourceReceptionChallanId: reception.id,
        sourceReference: reception.challan_no,
        vendorId: reception.vendor_id || 0,
        vendorName: reception.vendor_name || '',
        vendorGstin: reception.vendor_gstin || '',
        location: reception.location || 'MAIN',
        maintainStocks: true,
        notes: `Return of the unused stock from reception ${reception.challan_no}.`,
        items,
      },
      actor,
    );
  }

  /// In plain words, why the reception was not cancelled and what was made.
  function partlyUsedNotice(usage, returnChallan) {
    const made = `A draft return challan ${returnChallan.challan_no} was made for`;
    if (usage.length === 1) {
      const [entry] = usage;
      const unit = entry.uom ? ` ${entry.uom}` : '';
      return `${entry.used} of ${entry.received}${unit} are already used or reserved, so this reception was not cancelled. ${made} the remaining ${entry.free}${unit}.`;
    }
    return `Part of this reception is already used or reserved, so it was not cancelled. ${made} what is left.`;
  }

  /// Puts back the stock an issued challan moved, one reversal per movement.
  /// Shared by cancel and delete, which differ only in what they call it.
  /// The caller holds the transaction. `usage` is the reception's usage (empty
  /// for any other challan), and must show nothing touched.
  async function reverseIssuedStock(existing, usage, actor, now, { reasonCode, referenceType }) {
    const challanType = normalizeChallanType(existing.type);
    const receivedBarcodes = new Set(usage.map((entry) => entry.barcode));
    const movementRows = await inventoryPorts.movements.forChallan(
      existing.id,
      challanType,
    );
    for (const movement of movementRows) {
      const reverseType = movement.movement_type === 'receive' ? 'issue' : 'receive';
      const qty = Number(movement.qty || 0);

      if (movement.item_id === 0 || !movement.item_id) {
        continue; // Skip legacy barcode-based movements or handle gracefully
      }

      const stockLocation = movement.to_location_id || existing.location || 'MAIN';
      const barcode = String(movement.material_barcode || '').trim();

      // A movement that names a real material is undone through the
      // movement engine, so the material's own stock position goes back
      // with it: a received material is taken out, a returned one is put
      // back. A movement that names no piece ('-') is undone the way it was
      // made, a ledger row and the item's stock.
      const namesMaterial = barcode && barcode !== '-' &&
        (receivedBarcodes.has(barcode) || !!existing.source_reception_challan_id);
      if (namesMaterial) {
        await inventoryPorts.movements.applyCore(
          {
            barcode,
            movementType: reverseType,
            qty,
            primaryQty: Number(movement.primary_qty || qty),
            uom: String(movement.uom || '').trim() || 'units',
            toLocationId: stockLocation,
            reasonCode,
            referenceType,
            referenceId: String(existing.id),
            sourceChallanId: existing.id,
            sourceChallanType: challanType,
            sourceChallanLineId: movement.source_challan_line_id || null,
            reversesMovementId: movement.id,
            actor,
          },
          { useTransaction: false },
        );
        if (receivedBarcodes.has(barcode)) {
          await inventoryPorts.receipts.retire(barcode, now);
        }
        continue;
      }

      await itemStock.assertLeaf(movement.item_id, movement.variation_leaf_node_id);

      await inventoryPorts.movements.recordChallanReversal({
        movement,
        reasonCode,
        referenceType,
        reverseType,
        stockLocation,
        challanId: existing.id,
        challanType,
        actorName: actor?.name || 'System',
        now,
      });

      const delta = reverseType === 'receive' ? qty : -qty;
      await itemStock.applyDelta({
        itemId: movement.item_id,
        variationLeafNodeId: movement.variation_leaf_node_id,
        locationId: stockLocation,
        delta,
        now,
      });
    }
  }

  /// Cancels a challan and puts its stock back.
  ///
  /// A reception is cancelled only while everything it brought in is still
  /// free. Then the received material itself is taken out of stock. If any of
  /// it is used, reserved or claimed by a run, the reception stays issued (it
  /// happened, and stock was drawn from it) and a draft vendor return is made
  /// for what is free; the row comes back with `returnChallanRow` and
  /// `cancelNotice` set. If nothing is free, the cancel is refused.
  async function cancelDeliveryChallan(id, actor = null) {
    const existing = await getDeliveryChallanRowById(id);
    if (!existing) {
      const error = new Error('Delivery challan not found.');
      error.statusCode = 404;
      throw error;
    }
    if (existing.status === 'cancelled') {
      return existing;
    }
    const challanType = normalizeChallanType(existing.type);
    const isIssuedReception = existing.status === 'issued' && challanType === 'reception';
    const usage = isIssuedReception ? await receptionUsage(existing.id) : [];
    if (usage.some((entry) => entry.touched)) {
      if (!usage.some((entry) => entry.free > QTY_EPSILON)) {
        const error = new Error(
          'Everything this reception brought in is already used, reserved or returned, so it cannot be cancelled.',
        );
        error.statusCode = 409;
        error.code = 'reception_fully_used';
        throw error;
      }
      const returnChallan = await createReturnForReception(existing, usage, actor);
      await logDeliveryChallanActivity(id, 'challan_return_raised', actor, {
        challanNo: existing.challan_no,
        returnChallanId: returnChallan.id,
        returnChallanNo: returnChallan.challan_no,
      });
      const row = await getDeliveryChallanRowById(id);
      row.returnChallanRow = returnChallan;
      row.cancelNotice = partlyUsedNotice(usage, returnChallan);
      return row;
    }
    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      if (existing.status === 'issued') {
        await reverseIssuedStock(existing, usage, actor, now, {
          reasonCode: 'challan_cancel_reversal',
          referenceType: 'challan-cancellation',
        });
      }
      await run(
        "UPDATE delivery_challans SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE id = ?",
        [actor?.id || null, now, id],
      );
      await logChange('delivery_challans', id, 'UPDATE');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    await logDeliveryChallanActivity(id, 'challan_cancelled', actor, {
      challanNo: existing.challan_no,
      type: challanType,
      previousStatus: existing.status,
    });
    return getDeliveryChallanRowById(id);
  }

  async function deleteDraftDeliveryChallan(id, actor = null) {
    const existing = await getDeliveryChallanRowById(id);
    if (!existing) {
      const error = new Error('Challan not found.');
      error.statusCode = 404;
      throw error;
    }
    if (existing.status !== 'draft' && existing.type !== 'reception') {
      const error = new Error('Only draft challans can be deleted.');
      error.statusCode = 400;
      throw error;
    }
    // An issued reception follows the cancel rule: it goes only while all it
    // brought in is still free. Once any of it is used, the challan is the
    // record of where that stock came from, so it stays.
    const isIssuedReception =
      existing.status === 'issued' && normalizeChallanType(existing.type) === 'reception';
    const usage = isIssuedReception ? await receptionUsage(existing.id) : [];
    if (usage.some((entry) => entry.touched)) {
      const error = new Error(
        'Part of what this reception brought in is already used, reserved or returned, so it cannot be deleted. Cancel it instead to raise a return for what is left.',
      );
      error.statusCode = 409;
      error.code = 'reception_in_use';
      throw error;
    }
    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      // Issued challans moved stock (reception = receive, delivery = issue); reverse
      // it before deleting so on_hand_qty stays correct, same as cancellation does.
      if (existing.status === 'issued') {
        await reverseIssuedStock(existing, usage, actor, now, {
          reasonCode: 'challan_delete_reversal',
          referenceType: 'challan-deletion',
        });
      }
      await run('UPDATE invoice_lines SET challan_id = NULL, challan_item_id = NULL WHERE challan_id = ?', [id]);
      await run('UPDATE reconciliation_waste_audit SET challan_id = NULL WHERE challan_id = ?', [id]);
      // Explicitly clean up child tables (handles cases where ON DELETE CASCADE may not fire)
      await run('DELETE FROM delivery_challan_activity_log WHERE challan_id = ?', [id]);
      await run('DELETE FROM delivery_challan_report_groups WHERE challan_id = ?', [id]);
      await run('DELETE FROM delivery_challan_order_items WHERE challan_id = ?', [id]);
      await run('DELETE FROM delivery_challan_items WHERE challan_id = ?', [id]);
      await run('DELETE FROM delivery_challans WHERE id = ?', [id]);
      await logChange('delivery_challans', id, 'DELETE');
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    // No post-delete activity log: delivery_challan_activity_log.challan_id has an
    // ON DELETE CASCADE FK, so logging the deletion after the challan is gone fails
    // with a FOREIGN KEY violation (and the row would be cascade-deleted anyway).
  }

  // Best-effort order completion: the reconcile has already committed, so a
  // blocked lifecycle transition must not fail the request. Steps a draft/
  // notStarted line up through inProgress so it can reach the terminal completed.
  async function completeOrderItemBestEffort(orderItemId, actor) {
    try {
      const order = await getOrderRowById(orderItemId);
      if (!order || order.status === 'completed') return false;
      if (order.status === 'draft' || order.status === 'notStarted') {
        await updateOrderLifecycle({ id: orderItemId, status: 'inProgress', actor });
      }
      await updateOrderLifecycle({ id: orderItemId, status: 'completed', actor });
      return true;
    } catch (error) {
      console.error(`[reconcile] order ${orderItemId} completion skipped: ${error.message}`);
      return false;
    }
  }

  // The order number a use challan was consumed for. saveDeliveryChallan does not
  // persist order linkage for internal challans, so the reliable reference is the
  // "Consumption for order <orderNo>" text the Use editor writes into
  // internal_purpose. Real order-id linkage (if any) is preferred when present.
  async function resolveReconcileOrderNo(challanRow) {
    let orderIds = await getDeliveryChallanOrderIds(challanRow.id);
    if (orderIds.length === 0 && Number(challanRow.order_id || 0) > 0) {
      orderIds = [Number(challanRow.order_id)];
    }
    if (orderIds.length > 0) {
      const rows = await getOrderRowsByIds(orderIds);
      const no = rows.map((r) => String(r.order_no || '').trim()).find(Boolean);
      if (no) return no;
    }
    if (String(challanRow.order_no || '').trim()) {
      return String(challanRow.order_no).trim();
    }
    const match = String(challanRow.internal_purpose || '').match(
      /consumption for order\s+(.+)$/i,
    );
    return match ? match[1].trim() : '';
  }

  // How many OTHER internal-use challans for the same order are still awaiting
  // reconciliation (issued, same "Consumption for order …" reference). Zero means
  // this reconcile was the last one, so the order can be marked completed.
  async function pendingUseChallanCountForOrderNo(internalPurpose, excludeChallanId) {
    const row = await get(
      `SELECT COUNT(*) AS c FROM delivery_challans
       WHERE type = 'internal' AND status = 'issued' AND id <> ?
         AND lower(internal_purpose) = lower(?)`,
      [excludeChallanId, internalPurpose],
    );
    return Number(row?.c || 0);
  }

  return {
    getDeliveryChallanItems,
    getDeliveryChallanOrderIds,
    normalizeReportGroupCode,
    normalizeReportGroupCodes,
    deriveReportGroupCodesFromOrderIds,
    getDeliveryChallanReportGroupCodes,
    effectiveReportGroupCodesForChallan,
    replaceChallanReportGroups,
    getOrderRowsByIds,
    rowToDeliveryChallanItemDto,
    rowToDeliveryChallanDto,
    generateChallanNumber,
    challanNumberWarning,
    normalizeChallanDate,
    normalizeDeliveryChallanMeasure,
    normalizeChallanSheetWeights,
    normalizeDeliveryChallanItems,
    getDeliveryChallanRowById,
    listDeliveryChallans,
    getOrderForDeliveryChallan,
    normalizeDeliveryChallanOrderIds,
    getOrdersForDeliveryChallan,
    orderItemSnapshotFromOrder,
    getVendorForChallan,
    validateProductionRunForChallanLine,
    logDeliveryChallanActivity,
    assertCanChangeIssuedChallanNo,
    saveDeliveryChallan,
    issueDeliveryChallan,
    cancelDeliveryChallan,
    deleteDraftDeliveryChallan,
    completeOrderItemBestEffort,
    resolveReconcileOrderNo,
    pendingUseChallanCountForOrderNo,
  };
}

module.exports = { createChallanService };
