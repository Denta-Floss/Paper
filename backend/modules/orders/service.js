'use strict';

const crypto = require('crypto');
const path = require('path');

const ORDER_LIFECYCLE_TRANSITIONS = {
  draft:      new Set(['notStarted', 'inProgress']),
  notStarted: new Set(['draft', 'inProgress', 'delayed']),
  inProgress: new Set(['notStarted', 'completed', 'delayed']),
  delayed:    new Set(['inProgress', 'completed', 'notStarted']),
  completed:  new Set(['inProgress', 'delayed']), // admin-only reversal handled in updateOrderLifecycle
};

const ALLOWED_PO_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

function normalizePoFileName(fileName) {
  const baseName = path.basename(String(fileName || '').trim());
  return baseName
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 160) || 'purchase-order';
}

function normalizeUploadType(uploadType) {
  return String(uploadType || '').trim().toUpperCase();
}

function normalizeMaterialRequirementNumber(value, fieldName) {
  if (value == null || value === '') {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const error = new Error(`Invalid material requirement ${fieldName}.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function normalizeOptionalDate(value, fieldName) {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    const error = new Error(`Invalid ${fieldName}.`);
    error.statusCode = 400;
    throw error;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function orderActivityTitle(activityType) {
  switch (activityType) {
    case 'order_created':
      return 'Order created';
    case 'order_updated':
      return 'Order updated';
    case 'lifecycle_updated':
      return 'Lifecycle updated';
    case 'po_documents_linked':
      return 'PO documents linked';
    default:
      return 'Order activity logged';
  }
}

function rowToOrderDto(row) {
  if (!row) {
    return null;
  }

  const parseJson = (raw, fallback = null) => {
    if (!raw) return fallback;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  return {
    id: row.id,
    orderNo: row.order_no || '',
    clientId: row.client_id || 0,
    subContractorId: row.sub_contractor_id || null,
    clientName: row.client_name || '',
    poNumber: row.po_number || '',
    clientCode: row.client_code || '',
    itemId: row.item_id || 0,
    itemName: row.item_name || '',
    variationLeafNodeId: row.variation_leaf_node_id || 0,
    variationPathLabel: row.variation_path_label || '',
    variationPathNodeIds: parseJson(row.variation_path_node_ids_json, []),
    customVariationValues: parseJson(row.custom_variation_values_json, {}),
    quantity: Number(row.quantity || 0),
    unitId: row.unit_id || null,
    unitName: row.unit_name || '',
    unitSymbol: row.unit_symbol || '',
    unitPrice: Number(row.unit_price || 0),
    totalInvoicedQty: Number(row.total_invoiced_qty || 0),
    totalDeliveredQty: Number(row.total_delivered_qty || 0),
    status: row.status || 'notStarted',
    createdAt: row.created_at,
    startDate: row.start_date,
    endDate: row.end_date,
    hsnCode: row.hsn_code || '',
    taxableValue: Number(row.taxable_value || 0),
    cgstRate: Number(row.cgst_rate || 0),
    sgstRate: Number(row.sgst_rate || 0),
    cgstAmount: Number(row.cgst_amount || 0),
    sgstAmount: Number(row.sgst_amount || 0),
  };
}

function rowToPoDocumentDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    fileName: row.file_name || '',
    contentType: row.content_type || '',
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || '',
    objectKey: row.object_key || '',
    status: row.status || 'uploaded',
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    linkedAt: row.linked_at || null,
  };
}

function rowToOrderActivityDto(row) {
  if (!row) {
    return null;
  }

  const parseJson = (raw, fallback = null) => {
    if (!raw) return fallback;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  return {
    id: row.id,
    orderId: row.order_id || 0,
    activityType: row.activity_type || row.event_type || '',
    actorUserId: row.actor_user_id || null,
    actorName: row.actor_name || '',
    actorRole: row.actor_role || '',
    source: row.source || '',
    details: parseJson(row.details_json || row.metadata_json, null),
    createdAt: row.created_at,
  };
}

function rowToOrderStatusHistoryDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orderId: row.order_id || 0,
    previousStatus: row.previous_status || null,
    newStatus: row.new_status || '',
    changedByUserId: row.changed_by_user_id || null,
    changedAt: row.changed_at,
  };
}

module.exports = function createOrdersService(ctx) {
  const {
    all,
    get,
    run,
    parseJson = (raw, fallback = null) => {
      if (!raw) return fallback;
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    itemsPorts,
    challansPorts,
    // S3 & uploads
    buildS3ObjectKey,
    presignS3Url,
    assertS3ObjectExists,
    cleanupStaleUnlinkedPoDocuments = async () => {},
    assertValidPoUploadInput,
    // Seam thunks
    getClientRowById,
    getClientNameAndAlias = async (id) => getClientRowById ? getClientRowById(id) : null,
    getSubContractorById = async () => null,
    getUnitRowById,
    getItemUnitConversion,
    getOrderRowsWithEnrichedStatus,
    getOrderRowWithEnrichedStatus,
    getOrderPipelineRunsFromSeam,
    getOrderProductionReportFromSeam,
    getConsumedMovementsForPipelineRun = async () => [],
    deletePipelineRunFromSeam = async () => {},
    applyInventoryMovementCore,
    recordActivityLog = async () => {},
  } = ctx;

  let _orderActivityLogColumns = null;
  async function getOrderActivityLogColumns() {
    if (!_orderActivityLogColumns) {
      const columns = await all('PRAGMA table_info(order_activity_log)');
      _orderActivityLogColumns = new Set(columns.map((col) => col.name));
    }
    return _orderActivityLogColumns;
  }

  async function insertOrderActivityLog({
    orderId,
    activityType,
    actor = null,
    source = 'api',
    details = {},
    createdAt = new Date().toISOString(),
  }) {
    const available = await getOrderActivityLogColumns();
    const detailsJson = JSON.stringify(details || {});
    const valuesByColumn = {
      order_id: orderId,
      activity_type: activityType,
      event_type: activityType,
      title: orderActivityTitle(activityType),
      description: '',
      actor_user_id: actor?.id || null,
      actor_name: actor?.name || 'System',
      actor_role: actor?.role || 'system',
      source: actor?.source || source || 'api',
      details_json: detailsJson,
      metadata_json: detailsJson,
      created_at: createdAt,
    };
    const insertColumns = Object.keys(valuesByColumn).filter((column) =>
      available.has(column),
    );
    const placeholders = insertColumns.map(() => '?').join(', ');
    await run(
      `
      INSERT INTO order_activity_log (${insertColumns.join(', ')})
      VALUES (${placeholders})
      `,
      insertColumns.map((column) => valuesByColumn[column]),
    );
  }

  async function assertPoDocumentsUploaded(documentIds = []) {
    const uniqueIds = [...new Set((Array.isArray(documentIds) ? documentIds : []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    if (uniqueIds.length === 0) {
      return;
    }
    for (const documentId of uniqueIds) {
      const document = await get(
        "SELECT id FROM po_documents WHERE id = ? AND status = 'uploaded'",
        [documentId],
      );
      if (!document) {
        const error = new Error('One or more PO documents were not uploaded.');
        error.statusCode = 400;
        throw error;
      }
    }
  }

  async function linkPoDocumentsToOrder(orderId, documentIds = []) {
    const uniqueIds = [...new Set((Array.isArray(documentIds) ? documentIds : []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    if (uniqueIds.length === 0) {
      return { linked: [], newlyLinkedIds: [] };
    }
    const now = new Date().toISOString();
    const linked = [];
    const newlyLinkedIds = [];
    for (const documentId of uniqueIds) {
      const document = await get(
        "SELECT * FROM po_documents WHERE id = ? AND status = 'uploaded'",
        [documentId],
      );
      if (!document) {
        const error = new Error('One or more PO documents were not uploaded.');
        error.statusCode = 400;
        throw error;
      }
      const result = await run(
        'INSERT OR IGNORE INTO order_po_documents (order_id, document_id, linked_at) VALUES (?, ?, ?)',
        [orderId, documentId, now],
      );
      if (result.changes > 0) {
        newlyLinkedIds.push(documentId);
      }
      linked.push(rowToPoDocumentDto(document));
    }
    return { linked, newlyLinkedIds };
  }

  async function getPoDocumentsForOrder(orderId) {
    const rows = await all(
      `
      SELECT d.*, od.linked_at
      FROM po_documents d
      INNER JOIN order_po_documents od ON od.document_id = d.id
      WHERE od.order_id = ?
      ORDER BY datetime(od.linked_at) DESC, d.id DESC
      `,
      [orderId],
    );
    return rows.map(rowToPoDocumentDto);
  }

  async function createPoUploadIntent(input) {
    await cleanupStaleUnlinkedPoDocuments();
    const normalized = typeof assertValidPoUploadInput === 'function'
      ? assertValidPoUploadInput(input || {})
      : (() => {
          const fileName = normalizePoFileName(input?.fileName);
          const contentType = String(input?.contentType || '').trim().toLowerCase();
          const sizeBytes = Number(input?.sizeBytes || 0);
          const sha256 = String(input?.sha256 || '').trim().toLowerCase();
          const uploadType = normalizeUploadType(input?.uploadType || 'ORDER_PO');
          if (!ALLOWED_PO_CONTENT_TYPES.has(contentType)) {
            const error = new Error('Unsupported PO document format.');
            error.statusCode = 400;
            throw error;
          }
          if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 25 * 1024 * 1024) {
            const error = new Error('File size must be between 1 byte and 25MB.');
            error.statusCode = 400;
            throw error;
          }
          if (!/^[a-f0-9]{64}$/.test(sha256)) {
            const error = new Error('Valid sha256 checksum is required.');
            error.statusCode = 400;
            throw error;
          }
          return { fileName, contentType, sizeBytes, sha256, uploadType };
        })();

    const existing = await get(
      "SELECT * FROM po_documents WHERE sha256 = ? AND status = 'uploaded'",
      [normalized.sha256],
    );
    if (existing) {
      return {
        alreadyUploaded: true,
        document: rowToPoDocumentDto(existing),
        upload: null,
      };
    }

    const objectKey = buildS3ObjectKey({
      uploadType: normalized.uploadType,
      fileName: normalized.fileName,
      sha256: normalized.sha256,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const uploadSessionId = `po-upload-${now.getTime()}-${crypto
      .randomBytes(8)
      .toString('hex')}`;
    await run(
      `
      INSERT INTO po_upload_sessions (
        id, file_name, content_type, size_bytes, sha256, object_key, status, expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `,
      [
        uploadSessionId,
        normalized.fileName,
        normalized.contentType,
        normalized.sizeBytes,
        normalized.sha256,
        objectKey,
        expiresAt,
        now.toISOString(),
      ],
    );

    return {
      alreadyUploaded: false,
      document: null,
      upload: {
        uploadSessionId,
        objectKey,
        uploadUrl: await presignS3Url({
          method: 'PUT',
          objectKey,
          contentType: normalized.contentType,
          expiresSeconds: 900,
        }),
        expiresAt,
        headers: {
          'Content-Type': normalized.contentType,
        },
      },
    };
  }

  async function completePoUpload({ uploadSessionId, objectKey }) {
    const session = await get('SELECT * FROM po_upload_sessions WHERE id = ?', [
      uploadSessionId,
    ]);
    if (!session || session.object_key !== objectKey) {
      const error = new Error('Upload session not found.');
      error.statusCode = 404;
      throw error;
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      const error = new Error('Upload session expired.');
      error.statusCode = 410;
      throw error;
    }
    await assertS3ObjectExists(session.object_key);

    const now = new Date().toISOString();
    await run(
      `
      INSERT OR IGNORE INTO po_documents (
        file_name, content_type, size_bytes, sha256, object_key, status, created_at, uploaded_at
      )
      VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?)
      `,
      [
        session.file_name,
        session.content_type,
        Number(session.size_bytes || 0),
        session.sha256,
        session.object_key,
        session.created_at || now,
        now,
      ],
    );
    await run(
      "UPDATE po_upload_sessions SET status = 'completed', completed_at = ? WHERE id = ?",
      [now, uploadSessionId],
    );
    const document = await get('SELECT * FROM po_documents WHERE sha256 = ?', [
      session.sha256,
    ]);
    return rowToPoDocumentDto(document);
  }

  async function createPoDocumentReadUrl(documentId) {
    const document = await get(
      "SELECT * FROM po_documents WHERE id = ? AND status = 'uploaded'",
      [documentId],
    );
    if (!document) {
      const error = new Error('PO document not found.');
      error.statusCode = 404;
      throw error;
    }
    return {
      document: rowToPoDocumentDto(document),
      readUrl: await presignS3Url({
        method: 'GET',
        objectKey: document.object_key,
        expiresSeconds: 300,
      }),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  }

  async function resolveOrderUnitSelection({ item, unitId = null }) {
    const itemUnitId = Number(item?.unit_id || 0);
    const requestedUnitId = Number(unitId || 0);
    const normalizedUnitId = requestedUnitId > 0 ? requestedUnitId : itemUnitId;
    if (!normalizedUnitId) {
      return {
        unitId: null,
        unitName: 'Pieces',
        unitSymbol: 'Pieces',
      };
    }

    const unit = await getUnitRowById(normalizedUnitId);
    if (!unit || unit.is_archived) {
      const error = new Error(
        'That unit is no longer active. Pick another unit or restore it in Masters → Units.',
      );
      error.statusCode = 400;
      throw error;
    }

    let factorToPrimary = 1;

    if (requestedUnitId > 0 && requestedUnitId !== itemUnitId) {
      const conversion = await getItemUnitConversion(item.id, requestedUnitId);
      if (!conversion) {
        const error = new Error(
          'This item does not use that unit yet. Add the conversion in the order line, then save again.',
        );
        error.statusCode = 400;
        throw error;
      }
      factorToPrimary = Number(conversion.factor_to_primary) || 1;
    }

    return {
      unitId: unit.id,
      unitName: unit.name || 'Pieces',
      unitSymbol: unit.symbol || unit.name || 'Pieces',
      factorToPrimary,
    };
  }

  async function getOrderRowById(id) {
    if (typeof getOrderRowWithEnrichedStatus === 'function') {
      const row = await getOrderRowWithEnrichedStatus(id);
      if (!row) return row;
      if (challansPorts?.delivery?.qtyForOrderItem) {
        row.total_delivered_qty = await challansPorts.delivery.qtyForOrderItem(row.id);
      }
      return row;
    }

    const row = await get('SELECT * FROM order_items WHERE id = ?', [id]);
    if (!row) return row;
    if (challansPorts?.delivery?.qtyForOrderItem) {
      row.total_delivered_qty = await challansPorts.delivery.qtyForOrderItem(row.id);
    }
    return row;
  }

  async function getOrders() {
    let rows;
    if (typeof getOrderRowsWithEnrichedStatus === 'function') {
      rows = await getOrderRowsWithEnrichedStatus();
    } else {
      rows = await all(`
        SELECT o.*
        FROM order_items o 
        ORDER BY datetime(o.created_at) DESC, o.id DESC
      `);
    }

    if (challansPorts?.delivery?.qtyByOrderItems) {
      const delivered = await challansPorts.delivery.qtyByOrderItems(rows.map((r) => r.id));
      for (const row of rows) {
        row.total_delivered_qty = delivered.get(Number(row.id)) || 0;
      }
    }
    return rows;
  }

  async function saveOrder({
    orderNo,
    clientId,
    subContractorId = null,
    clientName = '',
    poNumber = '',
    clientCode = '',
    itemId,
    itemName = '',
    variationLeafNodeId = 0,
    variationPathLabel = '',
    variationPathNodeIds = [],
    customVariationValues = {},
    quantity,
    unitId = null,
    unitName = '',
    unitSymbol = '',
    unitPrice = 0,
    totalInvoicedQty,
    status = 'notStarted',
    startDate = null,
    endDate = null,
    poDocumentIds = [],
    materialRequirements = [],
    actor = null,
  } = {}, { returnMeta = false } = {}) {
    const trimmedOrderNo = String(orderNo || '').trim();
    const normalizedClientId = Number(clientId);
    let normalizedSubContractorId = null;
    if (subContractorId) {
      normalizedSubContractorId = Number(subContractorId);
    }
    const normalizedItemId = Number(itemId);
    const normalizedQuantity = Number(quantity || 0);
    const normalizedUnitPrice = Number(unitPrice || 0);
    const hasInvoicedQtyInput =
      totalInvoicedQty !== undefined && totalInvoicedQty !== null;
    const normalizedTotalInvoicedQty = Number(totalInvoicedQty || 0);
    const normalizedStartDate = normalizeOptionalDate(startDate, 'start date');
    const normalizedEndDate = normalizeOptionalDate(endDate, 'end date');
    const trimmedPoNumber = String(poNumber || '').trim();
    let trimmedClientName = String(clientName || '').trim();
    let trimmedClientCode = String(clientCode || '').trim();
    let trimmedItemName = String(itemName || '').trim();
    const allowedStatuses = new Set([
      'draft',
      'notStarted',
      'inProgress',
      'completed',
      'delayed',
    ]);
    const normalizedStatus = allowedStatuses.has(status) ? status : 'notStarted';

    if (!trimmedOrderNo) {
      const error = new Error('Order number is required.');
      error.statusCode = 400;
      throw error;
    }
    if (!normalizedClientId || !normalizedItemId) {
      const error = new Error('Client and item are required.');
      error.statusCode = 400;
      throw error;
    }
    const client = await getClientRowById(normalizedClientId);
    if (!client || client.is_archived) {
      const error = new Error('Selected client is not available.');
      error.statusCode = 400;
      throw error;
    }
    if (normalizedSubContractorId) {
      const subContractor = await getSubContractorById(normalizedSubContractorId);
      if (!subContractor) {
        const error = new Error('Selected sub-contractor is not available.');
        error.statusCode = 400;
        throw error;
      }
      if (subContractor.client_id !== normalizedClientId) {
        const error = new Error('Selected sub-contractor does not belong to the selected client.');
        error.statusCode = 400;
        throw error;
      }
    }
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      const error = new Error('Quantity must be greater than zero.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isInteger(normalizedQuantity)) {
      const error = new Error('Quantity must be a whole number.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isFinite(normalizedUnitPrice) || normalizedUnitPrice < 0) {
      const error = new Error('Unit price cannot be negative.');
      error.statusCode = 400;
      throw error;
    }
    if (
      hasInvoicedQtyInput &&
      (!Number.isFinite(normalizedTotalInvoicedQty) ||
        normalizedTotalInvoicedQty < 0)
    ) {
      const error = new Error('Total invoiced quantity cannot be negative.');
      error.statusCode = 400;
      throw error;
    }
    const variationSelection = await itemsPorts.resolveSelection({
      itemId: normalizedItemId,
      variationLeafNodeId,
      variationPathNodeIds,
      variationPathLabel,
      status: normalizedStatus,
    });
    const unitSelection = await resolveOrderUnitSelection({
      item: variationSelection.item,
      unitId,
    });
    const factorToPrimary = unitSelection.factorToPrimary || 1;

    if (!trimmedClientName && client) {
      trimmedClientName = String(client.name || '').trim();
    }
    if (!trimmedClientCode && client) {
      trimmedClientCode = String(client.alias || '').trim();
    }
    if (!trimmedItemName && variationSelection && variationSelection.item) {
      trimmedItemName = String(variationSelection.item.name || '').trim();
    }
    const normalizedUnitName =
      unitSelection.unitName || String(unitName || '').trim() || 'Pieces';
    const normalizedUnitSymbol =
      unitSelection.unitSymbol || String(unitSymbol || '').trim() || normalizedUnitName;
    const normalizedLeafId = variationSelection.variationLeafNodeId;
    const normalizedVariationPathJson = variationSelection.variationPathNodeIdsJson;
    const canonicalVariationPathLabel = variationSelection.variationPathLabel;
    const normalizedCustomVariationValuesJson = JSON.stringify(customVariationValues || {});
    await assertPoDocumentsUploaded(poDocumentIds);

    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      const existing = await get(
        `
        SELECT * FROM order_items
        WHERE LOWER(TRIM(order_no)) = LOWER(TRIM(?))
          AND client_id = ?
          AND item_id = ?
          AND variation_leaf_node_id = ?
          AND variation_path_node_ids_json = ?
          AND unit_id IS ?
          AND LOWER(TRIM(po_number)) = LOWER(TRIM(?))
          AND start_date IS ?
          AND end_date IS ?
        `,
        [
          trimmedOrderNo,
          normalizedClientId,
          normalizedItemId,
          normalizedLeafId,
          normalizedVariationPathJson,
          unitSelection.unitId,
          trimmedPoNumber,
          normalizedStartDate,
          normalizedEndDate,
        ],
      );

      let orderId;
      let merged = false;
      let quantityBefore = 0;
      let finalStatus = normalizedStatus;
      if (existing) {
        merged = true;
        quantityBefore = Number(existing.quantity || 0);
        const newTotalQty = quantityBefore + normalizedQuantity;
        const currentInvoiced = hasInvoicedQtyInput 
          ? normalizedTotalInvoicedQty 
          : Number(existing.total_invoiced_qty || 0);
          
        if (currentInvoiced > newTotalQty) {
          const error = new Error(`Cannot merge: Invoiced quantity (${currentInvoiced}) exceeds new requested quantity (${newTotalQty}).`);
          error.statusCode = 400;
          throw error;
        }

        const STATUS_RANK = { draft: 0, notStarted: 1, inProgress: 2, delayed: 2, completed: 3 };
        const existingRank = STATUS_RANK[existing.status] ?? 1;
        const incomingRank = STATUS_RANK[normalizedStatus] ?? 1;
        const mergedStatus = incomingRank > existingRank ? normalizedStatus : existing.status;
        finalStatus = mergedStatus;
        await run(
          `
          UPDATE order_items
          SET quantity = ?,
              client_name = ?,
              client_code = ?,
              item_name = ?,
              variation_path_label = ?,
              variation_path_node_ids_json = ?,
              unit_id = ?,
              unit_name = ?,
              unit_symbol = ?,
              unit_price = ?,
              total_invoiced_qty = ?,
              status = ?,
              start_date = ?,
              end_date = ?,
              custom_variation_values_json = ?,
              sub_contractor_id = ?,
              factor_to_primary_at_creation = ?,
              updated_at = ?
          WHERE id = ?
          `,
          [
            newTotalQty,
            trimmedClientName,
            trimmedClientCode,
            trimmedItemName,
            canonicalVariationPathLabel,
            normalizedVariationPathJson,
            unitSelection.unitId,
            normalizedUnitName,
            normalizedUnitSymbol,
            normalizedUnitPrice > 0 ? normalizedUnitPrice : Number(existing.unit_price || 0),
            hasInvoicedQtyInput
              ? normalizedTotalInvoicedQty
              : Number(existing.total_invoiced_qty || 0),
            mergedStatus,
            normalizedStartDate,
            normalizedEndDate,
            normalizedCustomVariationValuesJson,
            normalizedSubContractorId,
            factorToPrimary,
            now,
            existing.id,
          ],
        );
        if (existing.status !== mergedStatus) {
          await run(`
            INSERT INTO order_status_history (
              order_id, previous_status, new_status, changed_by_user_id, changed_at
            ) VALUES (?, ?, ?, ?, ?)
          `, [
            existing.id,
            existing.status,
            mergedStatus,
            actor?.id || null,
            now,
          ]);
        }
        orderId = existing.id;
      } else {
        await run(
          `
          INSERT INTO order_headers (order_no, client_id, po_number, sub_contractor_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(order_no) DO NOTHING
          `,
          [trimmedOrderNo, normalizedClientId, trimmedPoNumber, normalizedSubContractorId, now, now]
        );
        
        await run(
          `UPDATE order_headers SET sub_contractor_id = ?, updated_at = ? WHERE order_no = ?`,
          [normalizedSubContractorId, now, trimmedOrderNo]
        );
        
        const result = await run(
          `
          INSERT INTO order_items (
            order_no, client_id, client_name, po_number, client_code, item_id, item_name,
            variation_leaf_node_id, variation_path_label, variation_path_node_ids_json, quantity,
            unit_id, unit_name, unit_symbol, unit_price, total_invoiced_qty, status,
            custom_variation_values_json, sub_contractor_id,
            created_at, updated_at, start_date, end_date, factor_to_primary_at_creation
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            trimmedOrderNo,
            normalizedClientId,
            trimmedClientName,
            trimmedPoNumber,
            trimmedClientCode,
            normalizedItemId,
            trimmedItemName,
            normalizedLeafId,
            canonicalVariationPathLabel,
            normalizedVariationPathJson,
            normalizedQuantity,
            unitSelection.unitId,
            normalizedUnitName,
            normalizedUnitSymbol,
            normalizedUnitPrice,
            hasInvoicedQtyInput ? normalizedTotalInvoicedQty : 0,
            normalizedStatus,
            normalizedCustomVariationValuesJson,
            normalizedSubContractorId,
            now,
            now,
            normalizedStartDate,
            normalizedEndDate,
            factorToPrimary,
          ],
        );
        orderId = result.lastID;
      }

      const { newlyLinkedIds } = await linkPoDocumentsToOrder(orderId, poDocumentIds);
      const normalizedMaterialRequirements = Array.isArray(materialRequirements)
        ? materialRequirements
        : [];
      if (normalizedMaterialRequirements.length > 0) {
        await run('DELETE FROM order_material_requirements WHERE order_id = ?', [
          orderId,
        ]);
      }
      for (const req of normalizedMaterialRequirements) {
        await run(`
          INSERT INTO order_material_requirements (
            order_id, item_id, material_barcode,
            material_name, required_qty, allocated_qty, consumed_qty, shortage_qty,
            unit_id, unit_symbol, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          orderId,
          req.itemId || null,
          String(req.materialBarcode || '').trim(),
          String(req.materialName || '').trim(),
          normalizeMaterialRequirementNumber(req.requiredQty, 'required quantity'),
          normalizeMaterialRequirementNumber(req.allocatedQty, 'allocated quantity'),
          normalizeMaterialRequirementNumber(req.consumedQty, 'consumed quantity'),
          normalizeMaterialRequirementNumber(req.shortageQty, 'shortage quantity'),
          req.unitId || null,
          String(req.unitSymbol || '').trim(),
          req.status || 'pending',
          now,
          now
        ]);
      }

      const activityType = existing ? 'order_updated' : 'order_created';
      await insertOrderActivityLog({
        orderId,
        activityType,
        actor,
        details: {
          merged,
          previousQuantity: quantityBefore,
          quantityAfter: quantityBefore + normalizedQuantity,
          status: finalStatus,
          quantity: normalizedQuantity,
          newlyLinkedDocs: newlyLinkedIds.length,
          requirementsCount: normalizedMaterialRequirements.length,
        },
        createdAt: now,
      });

      if (newlyLinkedIds.length > 0) {
        await insertOrderActivityLog({
          orderId,
          activityType: 'po_documents_linked',
          actor,
          details: { documentIds: newlyLinkedIds },
          createdAt: now,
        });
      }

      const saved = await getOrderRowById(orderId);
      await run('COMMIT');
      if (returnMeta) {
        return {
          orderRow: saved,
          merged,
          quantityBefore,
          quantityAdded: normalizedQuantity,
          quantityAfter: quantityBefore + normalizedQuantity,
        };
      }
      return saved;
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function updateOrderLifecycle({
    id,
    status = null,
    startDate = null,
    endDate = null,
    actor = null,
  }) {
    const existing = await getOrderRowById(id);
    if (!existing) {
      const error = new Error('Order not found.');
      error.statusCode = 404;
      throw error;
    }
    
    const normalizedStartDate = normalizeOptionalDate(startDate, 'start date');
    const normalizedEndDate = normalizeOptionalDate(endDate, 'end date');
    const now = new Date().toISOString();

    let targetStatus = existing.status;
    let statusChanged = false;
    if (status && status !== existing.status) {
      const isAdmin = actor?.role === 'admin';
      if (existing.status === 'completed' && !isAdmin) {
        const error = new Error('Only admins can reverse completed orders.');
        error.statusCode = 403;
        throw error;
      }
      const allowed = ORDER_LIFECYCLE_TRANSITIONS[existing.status];
      if (!allowed || !allowed.has(status)) {
        if (!isAdmin) {
          const error = new Error(`Invalid lifecycle transition from ${existing.status} to ${status}.`);
          error.statusCode = 400;
          throw error;
        }
      }
      targetStatus = status;
      statusChanged = true;
    }

    await run('BEGIN TRANSACTION');
    try {
      await run(
        'UPDATE order_items SET status = ?, start_date = ?, end_date = ?, updated_at = ? WHERE id = ?',
        [targetStatus, normalizedStartDate, normalizedEndDate, now, id],
      );

      if (statusChanged) {
        await run(
          'INSERT INTO order_status_history (order_id, previous_status, new_status, changed_by_user_id, changed_at) VALUES (?, ?, ?, ?, ?)',
          [id, existing.status, targetStatus, actor?.id || null, now],
        );
      }

      await insertOrderActivityLog({
        orderId: id,
        activityType: 'lifecycle_updated',
        actor,
        details: {
          status: targetStatus,
          startDate: normalizedStartDate,
          endDate: normalizedEndDate,
        },
        createdAt: now,
      });

      const updated = await getOrderRowById(id);
      await run('COMMIT');
      return updated;
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function getOrderActivity(orderId) {
    const order = await getOrderRowById(orderId);
    if (!order) {
      const error = new Error('Order not found.');
      error.statusCode = 404;
      throw error;
    }
    return all(
      'SELECT * FROM order_activity_log WHERE order_id = ? ORDER BY datetime(created_at) ASC, id ASC',
      [orderId],
    );
  }

  async function getOrderStatusHistory(orderId) {
    const order = await getOrderRowById(orderId);
    if (!order) {
      const error = new Error('Order not found.');
      error.statusCode = 404;
      throw error;
    }
    return all(
      'SELECT * FROM order_status_history WHERE order_id = ? ORDER BY datetime(changed_at) ASC, id ASC',
      [orderId],
    );
  }

  async function getOrderPipelineRuns(orderNo) {
    if (typeof getOrderPipelineRunsFromSeam === 'function') {
      return getOrderPipelineRunsFromSeam(orderNo);
    }
    return [];
  }

  async function getOrderProductionReport(orderNo) {
    if (typeof getOrderProductionReportFromSeam === 'function') {
      return getOrderProductionReportFromSeam(orderNo);
    }
    return null;
  }

  async function deleteOrderAndRecoverMovements(orderId, body, actorName, userId) {
    await run('BEGIN TRANSACTION');
    try {
      const wipBarcode = body?.wip_barcode;
      const wipQty = Number(body?.wip_qty || 0);
      const recoveredMovements = [];

      const assignments = await all('SELECT * FROM order_pipeline_assignments WHERE order_item_id = ?', [orderId]);
      for (const assignment of assignments) {
        const runId = assignment.pipeline_run_id;

        const consumedMovements = await getConsumedMovementsForPipelineRun(runId);

        for (const move of consumedMovements) {
          const qty = move.qty;
          if (qty > 0 && typeof applyInventoryMovementCore === 'function') {
            await applyInventoryMovementCore({
              barcode: move.material_barcode,
              movementType: 'adjust_in',
              qty: qty,
              actor: actorName,
              referenceType: 'pipeline_dissolution',
              referenceId: String(orderId),
              reasonCode: 'ORDER_DELETED',
              toLocationId: move.from_location_id || 'MAIN'
            }, { useTransaction: false });
            recoveredMovements.push({ barcode: move.material_barcode, qty, reason: 'Raw Material Recovery' });
          }
        }

        await deletePipelineRunFromSeam(runId);
      }

      if (wipBarcode && wipQty > 0 && typeof applyInventoryMovementCore === 'function') {
        await applyInventoryMovementCore({
          barcode: wipBarcode,
          movementType: 'adjust_in',
          qty: wipQty,
          actor: actorName,
          referenceType: 'pipeline_dissolution',
          referenceId: String(orderId),
          reasonCode: 'WIP_RECOVERY',
          toLocationId: 'MAIN'
        }, { useTransaction: false });
        recoveredMovements.push({ barcode: wipBarcode, qty: wipQty, reason: 'WIP Recovery' });
      }

      await run('DELETE FROM order_pipeline_assignments WHERE order_item_id = ?', [orderId]);
      await run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_activity_log WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_material_requirements WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_po_documents WHERE order_id = ?', [orderId]);

      const item = await get('SELECT order_no FROM order_items WHERE id = ?', [orderId]);
      if (item) {
        await run('DELETE FROM order_items WHERE id = ?', [orderId]);
        const otherItems = await get('SELECT id FROM order_items WHERE order_no = ?', [item.order_no]);
        if (!otherItems) {
          await run('DELETE FROM order_headers WHERE order_no = ?', [item.order_no]);
        }
      }

      await recordActivityLog({
        entityType: 'order',
        entityId: String(orderId),
        action: 'deleted',
        userId,
        actorName,
        details: { reason: 'User requested Undo' }
      }).catch(() => {});

      await run('COMMIT');
      return recoveredMovements;
    } catch (err) {
      await run('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  return {
    rowToOrderDto,
    rowToPoDocumentDto,
    rowToOrderActivityDto,
    rowToOrderStatusHistoryDto,
    getOrderRowById,
    getOrders,
    normalizePoFileName,
    normalizeUploadType,
    normalizeMaterialRequirementNumber,
    normalizeOptionalDate,
    orderActivityTitle,
    getOrderActivityLogColumns,
    insertOrderActivityLog,
    assertPoDocumentsUploaded,
    linkPoDocumentsToOrder,
    getPoDocumentsForOrder,
    createPoUploadIntent,
    completePoUpload,
    createPoDocumentReadUrl,
    resolveOrderUnitSelection,
    saveOrder,
    updateOrderLifecycle,
    getOrderActivity,
    getOrderStatusHistory,
    getOrderPipelineRuns,
    getOrderProductionReport,
    getClientNameAndAlias,
    deleteOrderAndRecoverMovements,
  };
};
