'use strict';

const crypto = require('crypto');
const path = require('path');
const { imageSize } = require('image-size');
const PDFDocument = require('pdfkit');

// ---------------------------------------------------------------------------
// Challan templates: a scanned pre-printed challan form, the boxes mapped onto
// it, and the PDF that prints a challan's values into those boxes.
//
// Holds the template master (list, save, delete), the mapping normalisers, the
// page geometry (paper and stock sizes, n-up slots, millimetres to points), the
// table block, the snapshot a challan freezes at issue, the test-print fixture,
// the PDF generator, and the scan upload flow.
//
// Takes {get, all, run} plus, by name, the shared upload machinery and the
// challan readers it prints from (rowToDeliveryChallanDto and friends), which
// are still in server.js until the challan core moves.
// ---------------------------------------------------------------------------

function createChallanTemplateService({
  get,
  all,
  run,
  parseBooleanEnv,
  S3_UPLOAD_PREFIXES,
  normalizeChallanType,
  getDeliveryChallanOrderIds,
  getOrderRowsByIds,
  rowToDeliveryChallanDto,
  normalizeUploadType,
  getS3Prefix,
  buildS3ObjectKey,
  presignS3Url,
  assertS3ObjectExists,
  readS3ObjectBuffer,
  assetReadUrlPayload,
}) {
  function rowToChallanTemplateMappingDto(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      templateId: row.template_id,
      fieldType: row.field_type || 'DYNAMIC',
      fieldKey: row.field_key || '',
      fieldValue: row.field_value || '',
      assetObjectKey: row.asset_object_key || '',
      assetImageUrl: row.asset_image_url || null,
      assetWidthPx: Number(row.asset_width_px || 0),
      assetHeightPx: Number(row.asset_height_px || 0),
      widthMm: Number(
        row.width_mm ||
          (String(row.field_type || 'DYNAMIC').toUpperCase() === 'IMAGE'
            ? row.image_width_mm || 35
            : row.max_width_mm || 80),
      ),
      heightMm: Number(
        row.height_mm ||
          (String(row.field_type || 'DYNAMIC').toUpperCase() === 'IMAGE'
            ? row.image_height_mm || 20
            : 12),
      ),
      imageWidthMm: Number(row.image_width_mm || 35),
      imageHeightMm: Number(row.image_height_mm || 20),
      lockAspectRatio: Number(row.lock_aspect_ratio ?? 1) === 1,
      xMm: Number(row.x_mm || 0),
      yMm: Number(row.y_mm || 0),
      xPercent: Number(row.x_percent || 0),
      yPercent: Number(row.y_percent || 0),
      fontSize: Number(row.font_size || 10),
      fontWeight: row.font_weight || 'normal',
      alignment: row.alignment || 'left',
      textColor: row.text_color || 'black',
      letterSpacing: Number(row.letter_spacing || 0),
      maxChars: Number(row.max_chars || 0),
      maxWidthMm: Number(row.max_width_mm || 80),
      minFontSize: Number(row.min_font_size || 6),
      minRows: Number(row.min_rows || 0),
      maxRows: Number(row.max_rows || 0),
      tableHeightMm: Number(row.table_height_mm || 60),
      rowHeightMm: Number(row.row_height_mm || 6),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  async function rowToChallanTemplateDto(row, { includeMappings = true } = {}) {
    if (!row) {
      return null;
    }
    const mappings = includeMappings
      ? await all(
          `
          SELECT *
          FROM challan_template_mappings
          WHERE template_id = ?
          ORDER BY id ASC
          `,
          [row.id],
        )
      : [];
    let backgroundImageUrl = null;
    let backgroundImageUrlExpiresAt = null;
    if (row.background_object_key) {
      try {
        const payload = await assetReadUrlPayload(row.background_object_key);
        backgroundImageUrl = payload.readUrl;
        backgroundImageUrlExpiresAt = payload.expiresAt;
      } catch (_) {
        backgroundImageUrl = null;
        backgroundImageUrlExpiresAt = null;
      }
    }
    const mappedDtos = [];
    for (const mapping of mappings) {
      let assetImageUrl = null;
      if (mapping.asset_object_key) {
        try {
          const payload = await assetReadUrlPayload(mapping.asset_object_key);
          assetImageUrl = payload.readUrl;
        } catch (_) {
          assetImageUrl = null;
        }
      }
      mappedDtos.push(
        rowToChallanTemplateMappingDto({
          ...mapping,
          asset_image_url: assetImageUrl,
        }),
      );
    }
    return {
      id: row.id,
      name: row.name || '',
      partyType: row.party_type || '',
      partyId: Number(row.party_id || 0),
      challanType: normalizeChallanType(row.challan_type),
      backgroundObjectKey: row.background_object_key || '',
      backgroundImageUrl,
      backgroundImageUrlExpiresAt,
      canvasWidth: Number(row.canvas_width || 0),
      canvasHeight: Number(row.canvas_height || 0),
      rotationDegrees: Number(row.rotation_degrees || 0),
      globalOffsetXmm: Number(row.global_offset_x_mm || 0),
      globalOffsetYmm: Number(row.global_offset_y_mm || 0),
      stockSize: row.stock_size || row.paper_size || 'A4',
      paperSize: row.paper_size || 'A4',
      nUpLayout: Number(row.n_up_layout || 1),
      isActive: Number(row.is_active || 0) === 1,
      mappings: mappedDtos,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  function normalizeTemplatePartyType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'client' || normalized === 'vendor' || normalized === 'generic') {
      return normalized;
    }
    const error = new Error('Template party type must be client, vendor, or generic.');
    error.statusCode = 400;
    throw error;
  }

  function normalizeTemplateNumber(value, fallback, { min = null, max = null } = {}) {
    const numeric = Number(value ?? fallback);
    const normalized = Number.isFinite(numeric) ? numeric : fallback;
    if (min != null && normalized < min) {
      return min;
    }
    if (max != null && normalized > max) {
      return max;
    }
    return normalized;
  }

  function normalizeTemplateAlignment(value) {
    const normalized = String(value || 'left').trim().toLowerCase();
    return ['left', 'center', 'right'].includes(normalized) ? normalized : 'left';
  }

  function normalizeTemplateFieldType(value) {
    const normalized = String(value || 'DYNAMIC').trim().toUpperCase();
    if (normalized === 'STATIC' || normalized === 'IMAGE' || normalized === 'TABLE') {
      return normalized;
    }
    return 'DYNAMIC';
  }

  function normalizeTemplatePaperSize(value) {
    const normalized = String(value || 'A4').trim().toUpperCase();
    return ['A3', 'A4', 'A5', 'A6'].includes(normalized) ? normalized : 'A4';
  }

  function normalizeTemplateStockSize(value, fallback = 'A4') {
    const normalized = String(value || fallback).trim().toUpperCase();
    return ['A3', 'A4', 'A5', 'A6'].includes(normalized) ? normalized : fallback;
  }

  function normalizeTemplateNUpLayout(value) {
    const numeric = Math.round(Number(value || 1));
    return [1, 2, 4].includes(numeric) ? numeric : 1;
  }

  function normalizeTemplateTextColor(value) {
    const normalized = String(value || 'black').trim().toLowerCase();
    return ['black', 'blue', 'red'].includes(normalized) ? normalized : 'black';
  }

  function normalizeTemplateFieldKey(value) {
    return String(value || '')
      .trim()
      .replace(/[^\w.:-]/g, '_')
      .slice(0, 80);
  }

  function normalizeChallanTemplateMappings(mappings = []) {
    if (!Array.isArray(mappings)) {
      return [];
    }
    const seen = new Set();
    return mappings
      .map((mapping) => {
        const fieldType = normalizeTemplateFieldType(
          mapping?.fieldType ?? mapping?.field_type,
        );
        const fieldKey = normalizeTemplateFieldKey(
          mapping?.fieldKey ?? mapping?.field_key,
        );
        if (!fieldKey || seen.has(fieldKey)) {
          return null;
        }
        seen.add(fieldKey);
        return {
          fieldType,
          fieldKey,
          fieldValue: String(mapping?.fieldValue ?? mapping?.field_value ?? '')
            .trim()
            .slice(0, 1000),
          assetObjectKey: String(mapping?.assetObjectKey ?? mapping?.asset_object_key ?? '')
            .trim(),
          assetWidthPx: Math.max(
            0,
            Math.round(
              normalizeTemplateNumber(
                mapping?.assetWidthPx ?? mapping?.asset_width_px,
                0,
              ),
            ),
          ),
          assetHeightPx: Math.max(
            0,
            Math.round(
              normalizeTemplateNumber(
                mapping?.assetHeightPx ?? mapping?.asset_height_px,
                0,
              ),
            ),
          ),
          widthMm: normalizeTemplateNumber(
            mapping?.widthMm ??
              mapping?.width_mm ??
              (fieldType === 'IMAGE'
                ? mapping?.imageWidthMm ?? mapping?.image_width_mm
                : mapping?.maxWidthMm ?? mapping?.max_width_mm),
            fieldType === 'IMAGE' ? 35 : 80,
            { min: 2, max: 420 },
          ),
          heightMm: normalizeTemplateNumber(
            mapping?.heightMm ??
              mapping?.height_mm ??
              (fieldType === 'IMAGE'
                ? mapping?.imageHeightMm ?? mapping?.image_height_mm
                : 12),
            fieldType === 'IMAGE' ? 20 : 12,
            { min: 2, max: 420 },
          ),
          imageWidthMm: normalizeTemplateNumber(
            mapping?.imageWidthMm ?? mapping?.image_width_mm,
            35,
            { min: 2, max: 420 },
          ),
          imageHeightMm: normalizeTemplateNumber(
            mapping?.imageHeightMm ?? mapping?.image_height_mm,
            20,
            { min: 2, max: 420 },
          ),
          lockAspectRatio: parseBooleanEnv(
            mapping?.lockAspectRatio ?? mapping?.lock_aspect_ratio ?? true,
            true,
          ),
          xMm: normalizeTemplateNumber(
            mapping?.xMm ?? mapping?.x_mm,
            0,
            { min: 0, max: 420 },
          ),
          yMm: normalizeTemplateNumber(
            mapping?.yMm ?? mapping?.y_mm,
            0,
            { min: 0, max: 420 },
          ),
          xPercent: normalizeTemplateNumber(
            mapping?.xPercent ?? mapping?.x_percent,
            0,
            { min: 0, max: 1 },
          ),
          yPercent: normalizeTemplateNumber(
            mapping?.yPercent ?? mapping?.y_percent,
            0,
            { min: 0, max: 1 },
          ),
          fontSize: normalizeTemplateNumber(
            mapping?.fontSize ?? mapping?.font_size,
            10,
            { min: 6, max: 32 },
          ),
          fontWeight: String(
            mapping?.fontWeight ?? mapping?.font_weight ?? 'normal',
          )
            .trim()
            .toLowerCase() === 'bold'
            ? 'bold'
            : 'normal',
          alignment: normalizeTemplateAlignment(
            mapping?.alignment ?? mapping?.textAlign ?? mapping?.text_align,
          ),
          textColor: normalizeTemplateTextColor(
            mapping?.textColor ?? mapping?.text_color,
          ),
          letterSpacing: normalizeTemplateNumber(
            mapping?.letterSpacing ?? mapping?.letter_spacing,
            0,
            { min: -2, max: 6 },
          ),
          maxChars: Math.max(
            0,
            Math.round(
              normalizeTemplateNumber(
                mapping?.maxChars ?? mapping?.max_chars,
                0,
              ),
            ),
          ),
          maxWidthMm: normalizeTemplateNumber(
            mapping?.maxWidthMm ?? mapping?.max_width_mm,
            80,
            { min: 5, max: 210 },
          ),
          minFontSize: normalizeTemplateNumber(
            mapping?.minFontSize ?? mapping?.min_font_size,
            6,
            { min: 6, max: 32 },
          ),
          minRows: Math.max(
            0,
            Math.round(
              normalizeTemplateNumber(
                mapping?.minRows ?? mapping?.min_rows,
                0,
              ),
            ),
          ),
          maxRows: Math.max(
            0,
            Math.round(
              normalizeTemplateNumber(
                mapping?.maxRows ?? mapping?.max_rows,
                0,
              ),
            ),
          ),
          tableHeightMm: normalizeTemplateNumber(
            mapping?.tableHeightMm ?? mapping?.table_height_mm,
            60,
            { min: 5, max: 297 },
          ),
          rowHeightMm: normalizeTemplateNumber(
            mapping?.rowHeightMm ?? mapping?.row_height_mm,
            6,
            { min: 2, max: 20 },
          ),
        };
      })
      .filter(Boolean);
  }

  async function listChallanTemplates({
    partyType = '',
    partyId = null,
    challanType = '',
    activeOnly = false,
  } = {}) {
    const where = [];
    const params = [];
    if (partyType) {
      where.push('party_type = ?');
      params.push(normalizeTemplatePartyType(partyType));
    }
    const normalizedPartyId = Number(partyId || 0);
    if (Number.isInteger(normalizedPartyId) && normalizedPartyId > 0) {
      where.push('party_id = ?');
      params.push(normalizedPartyId);
    }
    if (challanType) {
      where.push('challan_type = ?');
      params.push(normalizeChallanType(challanType));
    }
    if (activeOnly) {
      where.push('is_active = 1');
    }
    const rows = await all(
      `
      SELECT *
      FROM challan_templates
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY is_active DESC, datetime(updated_at) DESC, id DESC
      `,
      params,
    );
    return Promise.all(rows.map((row) => rowToChallanTemplateDto(row)));
  }

  async function getChallanTemplateRowById(id) {
    return get('SELECT * FROM challan_templates WHERE id = ?', [Number(id)]);
  }

  async function saveChallanTemplate(input = {}, id = null) {
    const name = String(input.name || '').trim();
    const partyType = normalizeTemplatePartyType(
      input.partyType ?? input.party_type ?? 'generic',
    );
    const partyId = Number(input.partyId ?? input.party_id ?? 0);
    const challanType = normalizeChallanType(input.challanType ?? input.challan_type);
    const backgroundObjectKey = String(
      input.backgroundObjectKey ?? input.background_object_key ?? '',
    ).trim();
    const canvasWidth = Math.round(Number(input.canvasWidth ?? input.canvas_width ?? 0));
    const canvasHeight = Math.round(Number(input.canvasHeight ?? input.canvas_height ?? 0));
    const rotationDegrees = normalizeTemplateNumber(
      input.rotationDegrees ?? input.rotation_degrees,
      0,
      { min: -5, max: 5 },
    );
    const globalOffsetXmm = normalizeTemplateNumber(
      input.globalOffsetXmm ?? input.global_offset_x_mm,
      0,
      { min: -50, max: 50 },
    );
    const globalOffsetYmm = normalizeTemplateNumber(
      input.globalOffsetYmm ?? input.global_offset_y_mm,
      0,
      { min: -50, max: 50 },
    );
    const paperSize = normalizeTemplatePaperSize(
      input.paperSize ?? input.paper_size,
    );
    const stockSize = normalizeTemplateStockSize(
      input.stockSize ?? input.stock_size,
      paperSize,
    );
    const nUpLayout = normalizeTemplateNUpLayout(
      input.nUpLayout ?? input.n_up_layout,
    );
    const isActive = input.isActive ?? input.is_active ?? true;
    const mappings = normalizeChallanTemplateMappings(input.mappings || []);

    if (!name) {
      const error = new Error('Template name is required.');
      error.statusCode = 400;
      throw error;
    }
    if (
      partyType !== 'generic' &&
      (!Number.isInteger(partyId) || partyId <= 0)
    ) {
      const error = new Error('Template party is required.');
      error.statusCode = 400;
      throw error;
    }
    if (!backgroundObjectKey || !canvasWidth || !canvasHeight) {
      const error = new Error('Template background scan is required.');
      error.statusCode = 400;
      throw error;
    }
    validateTemplateSheetLayout({ stockSize, paperSize, nUpLayout });

    if (partyType !== 'generic') {
      const partyRow = partyType === 'client'
        ? await get('SELECT id FROM clients WHERE id = ? AND is_archived = 0', [partyId])
        : await get('SELECT id FROM vendors WHERE id = ? AND is_archived = 0', [partyId]);
      if (!partyRow) {
        const error = new Error('Template party does not exist or is archived.');
        error.statusCode = 400;
        throw error;
      }
    }

    const now = new Date().toISOString();
    await run('BEGIN TRANSACTION');
    try {
      let templateId = Number(id || 0);
      if (templateId > 0) {
        const existing = await getChallanTemplateRowById(templateId);
        if (!existing) {
          const error = new Error('Challan template not found.');
          error.statusCode = 404;
          throw error;
        }
        await run(
          `
          UPDATE challan_templates
          SET name = ?, party_type = ?, party_id = ?, challan_type = ?,
              background_object_key = ?, canvas_width = ?, canvas_height = ?,
              rotation_degrees = ?, global_offset_x_mm = ?, global_offset_y_mm = ?,
              stock_size = ?, paper_size = ?, n_up_layout = ?, is_active = ?, updated_at = ?
          WHERE id = ?
          `,
          [
            name,
            partyType,
            partyType === 'generic' ? 0 : partyId,
            challanType,
            backgroundObjectKey,
            canvasWidth,
            canvasHeight,
            rotationDegrees,
            globalOffsetXmm,
            globalOffsetYmm,
            stockSize,
            paperSize,
            nUpLayout,
            isActive ? 1 : 0,
            now,
            templateId,
          ],
        );
        await run('DELETE FROM challan_template_mappings WHERE template_id = ?', [
          templateId,
        ]);
      } else {
        const result = await run(
          `
          INSERT INTO challan_templates (
            name, party_type, party_id, challan_type, background_object_key,
            canvas_width, canvas_height, rotation_degrees, global_offset_x_mm,
            global_offset_y_mm, stock_size, paper_size, n_up_layout, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            name,
            partyType,
            partyType === 'generic' ? 0 : partyId,
            challanType,
            backgroundObjectKey,
            canvasWidth,
            canvasHeight,
            rotationDegrees,
            globalOffsetXmm,
            globalOffsetYmm,
            stockSize,
            paperSize,
            nUpLayout,
            isActive ? 1 : 0,
            now,
            now,
          ],
        );
        templateId = result.lastID;
      }

      if (isActive) {
        await run(
          `
          UPDATE challan_templates
          SET is_active = 0, updated_at = ?
          WHERE id != ? AND party_type = ? AND party_id = ? AND challan_type = ?
          `,
          [now, templateId, partyType, partyType === 'generic' ? 0 : partyId, challanType],
        );
      }

      for (const mapping of mappings) {
        if (mapping.fieldType === 'IMAGE' && !mapping.assetObjectKey) {
          const error = new Error('Image template mappings require an uploaded stamp asset.');
          error.statusCode = 400;
          throw error;
        }
        await run(
          `
          INSERT INTO challan_template_mappings (
            template_id, field_type, field_key, field_value, asset_object_key,
            asset_width_px, asset_height_px, width_mm, height_mm, image_width_mm, image_height_mm,
            lock_aspect_ratio, x_mm, y_mm, x_percent, y_percent, font_size, font_weight,
            alignment, text_color, letter_spacing, max_chars, max_width_mm,
            min_font_size, min_rows, max_rows, table_height_mm, row_height_mm,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            templateId,
            mapping.fieldType,
            mapping.fieldKey,
            mapping.fieldValue,
            mapping.assetObjectKey,
            mapping.assetWidthPx,
            mapping.assetHeightPx,
            mapping.widthMm,
            mapping.heightMm,
            mapping.imageWidthMm,
            mapping.imageHeightMm,
            mapping.lockAspectRatio ? 1 : 0,
            mapping.xMm,
            mapping.yMm,
            mapping.xPercent,
            mapping.yPercent,
            mapping.fontSize,
            mapping.fontWeight,
            mapping.alignment,
            mapping.textColor,
            mapping.letterSpacing,
            mapping.maxChars,
            mapping.maxWidthMm,
            mapping.minFontSize,
            mapping.minRows,
            mapping.maxRows,
            mapping.tableHeightMm,
            mapping.rowHeightMm,
            now,
            now,
          ],
        );
      }
      await run('COMMIT');
      return rowToChallanTemplateDto(await getChallanTemplateRowById(templateId));
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function deleteChallanTemplate(id) {
    const existing = await getChallanTemplateRowById(id);
    if (!existing) {
      const error = new Error('Challan template not found.');
      error.statusCode = 404;
      throw error;
    }
    await run('DELETE FROM challan_templates WHERE id = ?', [Number(id)]);
  }

  async function getTemplatePartyForChallan(challanRow) {
    const type = normalizeChallanType(challanRow?.type);
    if (type === 'reception') {
      const vendorId = Number(challanRow?.vendor_id || 0);
      return vendorId > 0 ? { partyType: 'vendor', partyId: vendorId } : null;
    }
    let orderIds = await getDeliveryChallanOrderIds(challanRow.id);
    if (orderIds.length === 0 && Number(challanRow.order_id || 0) > 0) {
      orderIds = [Number(challanRow.order_id || 0)];
    }
    const orders = await getOrderRowsByIds(orderIds);
    const clientId = Number(orders[0]?.client_id || 0);
    return clientId > 0 ? { partyType: 'client', partyId: clientId } : null;
  }

  async function findActiveChallanTemplateForChallan(challanRow) {
    const genericTemplate = await get(
      `
      SELECT *
      FROM challan_templates
      WHERE party_type = 'generic'
        AND party_id = 0
        AND challan_type = ?
        AND is_active = 1
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 1
      `,
      [normalizeChallanType(challanRow.type)],
    );
    if (genericTemplate) {
      return genericTemplate;
    }
    const party = await getTemplatePartyForChallan(challanRow);
    if (!party) {
      return null;
    }
    return get(
      `
      SELECT *
      FROM challan_templates
      WHERE party_type = ?
        AND party_id = ?
        AND challan_type = ?
        AND is_active = 1
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 1
      `,
      [party.partyType, party.partyId, normalizeChallanType(challanRow.type)],
    );
  }

  function truncateTemplateText(value, maxChars) {
    const text = String(value ?? '');
    const limit = Number(maxChars || 0);
    if (!Number.isInteger(limit) || limit <= 0 || text.length <= limit) {
      return text;
    }
    return text.slice(0, limit);
  }

  function challanTemplateScalarFields(challanDto) {
    const isReception = challanDto.type === 'reception';
    const items = Array.isArray(challanDto.items) ? challanDto.items : [];
    const totalPcs = items.reduce((sum, item) => sum + Number(item.quantity_pcs || 0), 0);
    const totalWeight = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
    const totalQty = totalPcs > 0
      ? `${totalPcs} pcs`
      : totalWeight > 0
      ? `${totalWeight} weight`
      : '0';
    const date = challanDto.date || '';
    const partyName = isReception
      ? challanDto.vendor_name || ''
      : challanDto.customer_name || '';
    const gstin = isReception
      ? challanDto.vendor_gstin || ''
      : challanDto.customer_gstin || '';
    return {
      challan_no: challanDto.challan_no || '',
      challanNo: challanDto.challan_no || '',
      date,
      challan_date: date,
      challanDate: date,
      party_name: partyName,
      partyName,
      client_name: partyName,
      clientName: partyName,
      customer_name: challanDto.customer_name || partyName,
      customerName: challanDto.customer_name || partyName,
      vendor_name: challanDto.vendor_name || partyName,
      vendorName: challanDto.vendor_name || partyName,
      gstin,
      gst_number: gstin,
      gstNumber: gstin,
      customer_gstin: challanDto.customer_gstin || gstin,
      customerGstin: challanDto.customer_gstin || gstin,
      vendor_gstin: challanDto.vendor_gstin || gstin,
      vendorGstin: challanDto.vendor_gstin || gstin,
      location: '',
      source_ref: isReception
        ? challanDto.source_reference || ''
        : (challanDto.order_nos || []).join(', ') || challanDto.order_no || '',
      sourceRef: isReception
        ? challanDto.source_reference || ''
        : (challanDto.order_nos || []).join(', ') || challanDto.order_no || '',
      total_qty: totalQty,
      totalQty,
      notes: challanDto.notes || '',
    };
  }

  function itemTableValueForField(fieldKey, item) {
    switch (fieldKey) {
      case 'item_particulars':
        return item.particulars || '';
      case 'hsn':
        return item.hsn_code || '';
      case 'qty_pcs':
        return item.quantity_pcs || '';
      case 'weight':
        return item.weight || '';
      case 'note':
        return item.note || '';
      default:
        return '';
    }
  }

  function pdfColorForTemplate(value) {
    switch (String(value || '').trim().toLowerCase()) {
      case 'blue':
        return '#1D4ED8';
      case 'red':
        return '#B91C1C';
      default:
        return 'black';
    }
  }

  function mmToPdfPoints(value) {
    return Number(value || 0) * 72 / 25.4;
  }

  function paperSizeMmForTemplate(value) {
    const normalized = normalizeTemplatePaperSize(value);
    if (normalized === 'A3') {
      return { widthMm: 297, heightMm: 420 };
    }
    if (normalized === 'A6') {
      return { widthMm: 105, heightMm: 148 };
    }
    if (normalized === 'A5') {
      return { widthMm: 148, heightMm: 210 };
    }
    return { widthMm: 210, heightMm: 297 };
  }

  function slotFramesForTemplate(paperSize, nUpLayout) {
    const page = paperSizeMmForTemplate(paperSize);
    if (Number(nUpLayout || 1) === 2) {
      return [
        { xMm: 0, yMm: 0, widthMm: page.widthMm, heightMm: page.heightMm / 2 },
        {
          xMm: 0,
          yMm: page.heightMm / 2,
          widthMm: page.widthMm,
          heightMm: page.heightMm / 2,
        },
      ];
    }
    if (Number(nUpLayout || 1) === 4) {
      return [
        { xMm: 0, yMm: 0, widthMm: page.widthMm / 2, heightMm: page.heightMm / 2 },
        {
          xMm: page.widthMm / 2,
          yMm: 0,
          widthMm: page.widthMm / 2,
          heightMm: page.heightMm / 2,
        },
        {
          xMm: 0,
          yMm: page.heightMm / 2,
          widthMm: page.widthMm / 2,
          heightMm: page.heightMm / 2,
        },
        {
          xMm: page.widthMm / 2,
          yMm: page.heightMm / 2,
          widthMm: page.widthMm / 2,
          heightMm: page.heightMm / 2,
        },
      ];
    }
    return [{ xMm: 0, yMm: 0, widthMm: page.widthMm, heightMm: page.heightMm }];
  }

  function resolveStockFrameForSlot(stockSize, slot) {
    const stock = paperSizeMmForTemplate(stockSize);
    if (stock.widthMm <= slot.widthMm && stock.heightMm <= slot.heightMm) {
      return {
        widthMm: stock.widthMm,
        heightMm: stock.heightMm,
        rotated: false,
      };
    }
    if (stock.heightMm <= slot.widthMm && stock.widthMm <= slot.heightMm) {
      return {
        widthMm: stock.heightMm,
        heightMm: stock.widthMm,
        rotated: true,
      };
    }
    return null;
  }

  function validateTemplateSheetLayout({ stockSize, paperSize, nUpLayout }) {
    const slots = slotFramesForTemplate(paperSize, nUpLayout);
    const resolved = resolveStockFrameForSlot(stockSize, slots[0]);
    if (!resolved) {
      const error = new Error(
        `Stock size ${stockSize} does not fit on ${paperSize} with ${nUpLayout}-up layout.`,
      );
      error.statusCode = 400;
      throw error;
    }
    return {
      page: paperSizeMmForTemplate(paperSize),
      slots,
      stockFrame: resolved,
    };
  }

  function layoutFramesForTemplate({ stockSize, paperSize, nUpLayout }) {
    const layout = validateTemplateSheetLayout({ stockSize, paperSize, nUpLayout });
    return {
      page: layout.page,
      frames: layout.slots.map((slot) => ({
        xMm: slot.xMm + (slot.widthMm - layout.stockFrame.widthMm) / 2,
        yMm: slot.yMm + (slot.heightMm - layout.stockFrame.heightMm) / 2,
        widthMm: layout.stockFrame.widthMm,
        heightMm: layout.stockFrame.heightMm,
      })),
      rotatedStock: layout.stockFrame.rotated,
      slots: layout.slots,
    };
  }

  function templateValue(source, camelKey, snakeKey, fallback = null) {
    if (!source) {
      return fallback;
    }
    if (source[camelKey] != null) {
      return source[camelKey];
    }
    if (source[snakeKey] != null) {
      return source[snakeKey];
    }
    return fallback;
  }

  function templateNumberValue(source, camelKey, snakeKey, fallback = 0) {
    const value = Number(templateValue(source, camelKey, snakeKey, fallback));
    return Number.isFinite(value) ? value : fallback;
  }

  async function buildChallanTemplateSnapshot(templateRow) {
    if (!templateRow) {
      return null;
    }
    const dto = await rowToChallanTemplateDto(templateRow);
    return {
      id: dto.id,
      name: dto.name,
      partyType: dto.partyType,
      partyId: dto.partyId,
      challanType: dto.challanType,
      backgroundObjectKey: dto.backgroundObjectKey,
      canvasWidth: dto.canvasWidth,
      canvasHeight: dto.canvasHeight,
      rotationDegrees: dto.rotationDegrees,
      globalOffsetXmm: dto.globalOffsetXmm,
      globalOffsetYmm: dto.globalOffsetYmm,
      stockSize: dto.stockSize,
      paperSize: dto.paperSize,
      nUpLayout: dto.nUpLayout,
      mappings: dto.mappings,
      snapshottedAt: new Date().toISOString(),
    };
  }

  function templateBoxWidthMm(mapping, frameWidthMm) {
    return normalizeTemplateNumber(
      templateValue(
        mapping,
        'widthMm',
        'width_mm',
        templateValue(mapping, 'fieldType', 'field_type', 'DYNAMIC') === 'IMAGE'
          ? templateNumberValue(mapping, 'imageWidthMm', 'image_width_mm', 35)
          : templateNumberValue(mapping, 'maxWidthMm', 'max_width_mm', 80),
      ),
      frameWidthMm,
      { min: 2, max: frameWidthMm },
    );
  }

  function templateBoxHeightMm(mapping, frameHeightMm) {
    return normalizeTemplateNumber(
      templateValue(
        mapping,
        'heightMm',
        'height_mm',
        templateValue(mapping, 'fieldType', 'field_type', 'DYNAMIC') === 'IMAGE'
          ? templateNumberValue(mapping, 'imageHeightMm', 'image_height_mm', 20)
          : 12,
      ),
      frameHeightMm,
      { min: 2, max: frameHeightMm },
    );
  }

  function templateCoordinateMm(mapping, axis, frameSizeMm) {
    const mmKey = axis === 'x' ? 'xMm' : 'yMm';
    const mmSnakeKey = axis === 'x' ? 'x_mm' : 'y_mm';
    const percentKey = axis === 'x' ? 'xPercent' : 'yPercent';
    const percentSnakeKey = axis === 'x' ? 'x_percent' : 'y_percent';
    const mmValue = templateNumberValue(mapping, mmKey, mmSnakeKey, 0);
    const percentValue = templateNumberValue(mapping, percentKey, percentSnakeKey, 0);
    if (mmValue > 0 || percentValue === 0) {
      return normalizeTemplateNumber(mmValue, 0, { min: 0, max: frameSizeMm });
    }
    return normalizeTemplateNumber(percentValue, 0, { min: 0, max: 1 }) * frameSizeMm;
  }

  function parseTemplateTableColumns(tableFrame, mappings = []) {
    const allowed = new Set(['item_particulars', 'hsn', 'qty_pcs', 'weight', 'note']);
    const defaultXByField = {
      item_particulars: 0,
      hsn: 72,
      qty_pcs: 102,
      weight: 124,
      note: 0,
    };
    const normalizeColumn = (column, index) => {
      if (typeof column === 'string') {
        const fieldKey = column.trim();
        if (!allowed.has(fieldKey)) {
          return null;
        }
        return {
          fieldKey,
          xMm: Number(defaultXByField[fieldKey] ?? index * 30),
        };
      }
      if (!column || typeof column !== 'object') {
        return null;
      }
      const fieldKey = String(column.fieldKey || column.field_key || '').trim();
      if (!allowed.has(fieldKey)) {
        return null;
      }
      return {
        fieldKey,
        xMm: normalizeTemplateNumber(column.xMm ?? column.x_mm, defaultXByField[fieldKey] ?? 0, {
          min: 0,
          max: 420,
        }),
      };
    };
    const raw = String(templateValue(tableFrame, 'fieldValue', 'field_value', '') || '').trim();
    let columns = [];
    if (raw) {
      try {
        const decoded = JSON.parse(raw);
        columns = Array.isArray(decoded?.columns)
          ? decoded.columns.map(normalizeColumn).filter(Boolean)
          : [];
      } catch (_) {}
    }
    if (!columns.length) {
      columns = mappings
        .map((mapping, index) =>
          normalizeColumn(
            String(templateValue(mapping, 'fieldKey', 'field_key', '') || '').trim(),
            index,
          ),
        )
        .filter(Boolean);
    }
    if (!columns.some((column) => column.fieldKey === 'item_particulars')) {
      columns.unshift({ fieldKey: 'item_particulars', xMm: 0 });
    }
    const seen = new Set();
    return columns.filter((column) => {
      if (seen.has(column.fieldKey)) {
        return false;
      }
      seen.add(column.fieldKey);
      return true;
    });
  }

  function templateTablePrintNotes(tableFrame) {
    const raw = String(templateValue(tableFrame, 'fieldValue', 'field_value', '') || '').trim();
    if (!raw) {
      return false;
    }
    try {
      const decoded = JSON.parse(raw);
      return decoded?.printNotes === true;
    } catch (_) {
      return false;
    }
  }

  function ensureCoreChallanFieldMappings(mappings = []) {
    const aliasesByCanonicalField = {
      date: new Set(['date', 'challan_date', 'challanDate']),
      party_name: new Set([
        'party_name',
        'partyName',
        'client_name',
        'clientName',
        'customer_name',
        'customerName',
        'vendor_name',
        'vendorName',
      ]),
      gstin: new Set([
        'gstin',
        'gst_number',
        'gstNumber',
        'customer_gstin',
        'customerGstin',
        'vendor_gstin',
        'vendorGstin',
      ]),
    };
    const existingKeys = new Set(
      mappings.map((mapping) =>
        String(templateValue(mapping, 'fieldKey', 'field_key', '') || '').trim(),
      ),
    );
    const hasAny = (aliases) => [...aliases].some((alias) => existingKeys.has(alias));
    const fallbackMappings = [
      {
        fieldType: 'DYNAMIC',
        fieldKey: 'date',
        xPercent: 0.62,
        yPercent: 0.08,
        widthMm: 46,
        heightMm: 12,
        fontSize: 10,
        fontWeight: 'normal',
        alignment: 'left',
        textColor: 'black',
      },
      {
        fieldType: 'DYNAMIC',
        fieldKey: 'party_name',
        xPercent: 0.08,
        yPercent: 0.18,
        widthMm: 150,
        heightMm: 14,
        fontSize: 10,
        fontWeight: 'normal',
        alignment: 'left',
        textColor: 'black',
      },
      {
        fieldType: 'DYNAMIC',
        fieldKey: 'gstin',
        xPercent: 0.08,
        yPercent: 0.25,
        widthMm: 150,
        heightMm: 12,
        fontSize: 10,
        fontWeight: 'normal',
        alignment: 'left',
        textColor: 'black',
      },
    ].filter((mapping) => !hasAny(aliasesByCanonicalField[mapping.fieldKey]));
    return [...mappings, ...fallbackMappings];
  }

  function drawTableBlock({
    doc,
    mapping,
    pageItems,
    xMm,
    yMm,
    widthMm,
    tableHeightMm,
    rowPitchMm,
    minRows,
    fontName,
    fontSize,
    minFontSize,
    textColor,
    letterSpacing,
    columns,
    displayId,
    printNotes,
  }) {
    const normalizedColumns = (columns.length
      ? columns
      : [{ fieldKey: 'item_particulars', xMm: 0 }])
      .map((column) => ({
        fieldKey: column.fieldKey,
        xMm: normalizeTemplateNumber(column.xMm, 0, { min: 0, max: widthMm }),
      }));
    const sortedColumns = [...normalizedColumns].sort((left, right) => left.xMm - right.xMm);
    const noteColumn = normalizedColumns.find((column) => column.fieldKey === 'note');
    const printableColumns = normalizedColumns.filter((column) => column.fieldKey !== 'note');
    const rowHeight = mmToPdfPoints(rowPitchMm);
    const rowCount = Math.max(pageItems.length, minRows);
    const fitFontSize = Math.max(
      minFontSize,
      Math.min(fontSize, Math.max(minFontSize, rowPitchMm * 2.2)),
    );
    doc.font(fontName).fontSize(fitFontSize).fillColor(textColor);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const item = pageItems[rowIndex];
      const currentY = yMm + rowIndex * rowPitchMm;
      for (const column of printableColumns) {
        const fieldKey = column.fieldKey;
        const columnIndex = sortedColumns.findIndex((entry) => entry.fieldKey === fieldKey);
        const nextColumn = sortedColumns
          .slice(columnIndex + 1)
          .find((entry) => entry.fieldKey !== 'note');
        const columnWidthMm = Math.max(
          6,
          Math.min(
            widthMm - column.xMm,
            (nextColumn ? nextColumn.xMm : widthMm) - column.xMm,
          ),
        );
        const value = item
          ? truncateTemplateText(
              itemTableValueForField(fieldKey, item),
              templateNumberValue(mapping, 'maxChars', 'max_chars', 0),
            )
          : '';
        const align = fieldKey === 'item_particulars' ? 'left' : 'center';
        doc.text(
          value,
          mmToPdfPoints(xMm + column.xMm),
          mmToPdfPoints(currentY),
          {
            width: mmToPdfPoints(columnWidthMm),
            height: rowHeight,
            align,
            characterSpacing: letterSpacing,
            lineBreak: true,
          },
        );
      }
      const note = item ? String(item.note || '').trim() : '';
      if (printNotes && noteColumn && note) {
        const noteWidthMm = Math.max(12, widthMm - noteColumn.xMm);
        doc
          .font('Helvetica-Oblique')
          .fontSize(7)
          .fillColor('#4B5563')
          .text(
            truncateTemplateText(note, templateNumberValue(mapping, 'maxChars', 'max_chars', 0)),
            mmToPdfPoints(xMm + noteColumn.xMm),
            mmToPdfPoints(currentY + 4),
            {
              width: mmToPdfPoints(noteWidthMm),
              height: rowHeight / 2,
              align: 'left',
              characterSpacing: letterSpacing,
              lineBreak: true,
            },
          )
          .font(fontName)
          .fontSize(fitFontSize)
          .fillColor(textColor);
      }
    }
    if (displayId) {
      const idY = yMm + Math.min(tableHeightMm, rowCount * rowPitchMm + 2);
      doc
        .font('Helvetica')
        .fontSize(6)
        .fillColor('#6B7280')
        .text(displayId, mmToPdfPoints(xMm + 5), mmToPdfPoints(idY), {
          width: mmToPdfPoints(Math.max(20, widthMm - 5)),
          lineBreak: false,
        })
        .font(fontName)
        .fontSize(fitFontSize)
        .fillColor(textColor);
    }
  }

  function buildTemplateTestChallanDto(itemCount = 3) {
    const normalizedItemCount = Math.max(1, Math.min(200, Math.round(Number(itemCount) || 3)));
    const sampleCatalog = [
      {
        particulars: 'SAMPLE PRODUCT DESCRIPTION 101',
        hsnCode: '1234',
        quantityPcs: '9,999',
        weight: '120.50',
        note: 'Packed in export-grade bundles',
      },
      {
        particulars: 'SAMPLE PRODUCT DESCRIPTION 202 WITH LONGER WRAP TEXT',
        hsnCode: '5678',
        quantityPcs: '240',
        weight: '18.25',
        note: 'Check shade before dispatch',
      },
      {
        particulars: 'SAMPLE PRODUCT DESCRIPTION 303',
        hsnCode: '9101',
        quantityPcs: '75',
        weight: '8.00',
        note: 'Short supply accepted by party',
      },
      {
        particulars: 'SAMPLE PRODUCT DESCRIPTION 404 EXTRA LONG TEXT FOR ROW FIT CHECKING',
        hsnCode: '1112',
        quantityPcs: '1,250',
        weight: '42.75',
        note: 'Handle carefully',
      },
    ];
    const items = Array.from({ length: normalizedItemCount }, (_, index) => {
      const sample = sampleCatalog[index % sampleCatalog.length];
      return {
        particulars:
          normalizedItemCount <= sampleCatalog.length
            ? sample.particulars
            : `${sample.particulars} #${String(index + 1).padStart(2, '0')}`,
        hsn_code: sample.hsnCode,
        quantity_pcs: sample.quantityPcs,
        weight: sample.weight,
        note: sample.note,
      };
    });
    return {
      id: 0,
      type: 'delivery',
      order_id: null,
      order_ids: [],
      order_no: 'SAMPLE-ORDER-001',
      order_nos: ['SAMPLE-ORDER-001'],
      client_id: 0,
      challan_no: 'DC-TEST-0001',
      display_id: 'REF: 00000',
      date: 'DD/MM/YYYY',
      location: '',
      customer_name: 'John Doe',
      customer_gstin: '27ABCDE1234F1Z5',
      vendor_id: null,
      vendor_name: '',
      vendor_gstin: '',
      source_reference: 'TEST-PRINT',
      company_profile_snapshot: null,
      notes: 'Sample preview for block alignment.',
      status: 'draft',
      created_by: null,
      updated_by: null,
      created_at: null,
      updated_at: null,
      items,
    };
  }

  async function generateChallanTemplatePdf({
    challanRow,
    templateRow,
    templateSnapshot = null,
    mode = 'digital',
    challanDtoOverride = null,
  }) {
    const normalizedMode = String(mode || 'digital').trim().toLowerCase() === 'overprint'
      ? 'overprint'
      : 'digital';
    const challanDto = challanDtoOverride || await rowToDeliveryChallanDto(challanRow);
    const templateSource = templateSnapshot || templateRow;
    const rawMappings = templateSnapshot
      ? (Array.isArray(templateSnapshot.mappings) ? templateSnapshot.mappings : [])
      : await all(
          `
          SELECT *
          FROM challan_template_mappings
          WHERE template_id = ?
          ORDER BY id ASC
          `,
          [templateRow.id],
        );
    const mappings = ensureCoreChallanFieldMappings(rawMappings);
    const paperSize = templateValue(templateSource, 'paperSize', 'paper_size', 'A4');
    const stockSize = templateValue(
      templateSource,
      'stockSize',
      'stock_size',
      paperSize,
    );
    const nUpLayout = normalizeTemplateNUpLayout(
      templateValue(templateSource, 'nUpLayout', 'n_up_layout', 1),
    );
    const layout = layoutFramesForTemplate({ stockSize, paperSize, nUpLayout });
    const pageSize = layout.page;
    const frames = layout.frames;
    const pageWidth = mmToPdfPoints(pageSize.widthMm);
    const pageHeight = mmToPdfPoints(pageSize.heightMm);
    const doc = new PDFDocument({
      size: [pageWidth, pageHeight],
      margin: 0,
      autoFirstPage: false,
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const fields = challanTemplateScalarFields(challanDto);
    const items = Array.isArray(challanDto.items) ? challanDto.items : [];
    const displayId = `REF: ${String(challanDto.id || challanRow?.id || 0).padStart(5, '0')}`;
    const tableFrame = mappings.find(
      (mapping) => String(templateValue(mapping, 'fieldKey', 'field_key', '')) === 'item_particulars',
    );
    const tableFields = new Set(['item_particulars', 'hsn', 'qty_pcs', 'weight', 'note']);
    const tableColumns = parseTemplateTableColumns(tableFrame, mappings);
    const tablePrintNotes = templateTablePrintNotes(tableFrame);
    const frameRowPitchMm = templateNumberValue(tableFrame, 'rowHeightMm', 'row_height_mm', 6);
    const frameTableHeightMm = templateNumberValue(tableFrame, 'tableHeightMm', 'table_height_mm', 60);
    const frameMinRows = Math.max(
      0,
      Math.round(templateNumberValue(tableFrame, 'minRows', 'min_rows', 0)),
    );
    const explicitMaxRows = Math.max(
      0,
      Math.round(templateNumberValue(tableFrame, 'maxRows', 'max_rows', 0)),
    );
    const computedRows = frameRowPitchMm > 0
      ? Math.max(1, Math.floor(frameTableHeightMm / frameRowPitchMm))
      : Math.max(1, explicitMaxRows || items.length || 1);
    const rowsPerPage = explicitMaxRows > 0 ? Math.min(explicitMaxRows, computedRows) : computedRows;
    const pageCount = Math.max(1, Math.ceil(Math.max(items.length, frameMinRows, 1) / rowsPerPage));

    const drawCutGuides = () => {
      if (layout.slots.length <= 1) {
        return;
      }
      doc.save();
      doc.dash(4, { space: 4 });
      doc.lineWidth(0.7).strokeColor('#8B5CF6').opacity(0.35);
      if (nUpLayout === 2) {
        const y = mmToPdfPoints(layout.slots[1].yMm);
        doc.moveTo(0, y).lineTo(pageWidth, y).stroke();
      } else if (nUpLayout === 4) {
        const x = mmToPdfPoints(layout.slots[1].xMm);
        const y = mmToPdfPoints(layout.slots[2].yMm);
        doc.moveTo(x, 0).lineTo(x, pageHeight).stroke();
        doc.moveTo(0, y).lineTo(pageWidth, y).stroke();
      }
      doc.undash();
      doc.restore();
    };

    const drawSingleChallan = async (pageItems, frame) => {
      const backgroundKey = templateValue(
        templateSource,
        'backgroundObjectKey',
        'background_object_key',
        '',
      );
      if (normalizedMode === 'digital' && backgroundKey) {
        try {
          const background = await readS3ObjectBuffer(backgroundKey);
          doc.save();
          doc.opacity(0.3);
          doc.image(background, mmToPdfPoints(frame.xMm), mmToPdfPoints(frame.yMm), {
            width: mmToPdfPoints(frame.widthMm),
            height: mmToPdfPoints(frame.heightMm),
          });
          doc.restore();
        } catch (_) {}
      }

      for (const mapping of mappings) {
        const fieldKey = String(templateValue(mapping, 'fieldKey', 'field_key', ''));
        const fieldType = String(templateValue(mapping, 'fieldType', 'field_type', 'DYNAMIC')).toUpperCase();
        const xMm =
          frame.xMm +
          templateCoordinateMm(mapping, 'x', frame.widthMm) +
          templateNumberValue(templateSource, 'globalOffsetXmm', 'global_offset_x_mm', 0);
        const yMm =
          frame.yMm +
          templateCoordinateMm(mapping, 'y', frame.heightMm) +
          templateNumberValue(templateSource, 'globalOffsetYmm', 'global_offset_y_mm', 0);
        const widthMm = templateBoxWidthMm(mapping, frame.widthMm);
        const heightMm = templateBoxHeightMm(mapping, frame.heightMm);
        if (fieldKey === 'item_particulars' || fieldType === 'TABLE') {
          const fontSize = templateNumberValue(mapping, 'fontSize', 'font_size', 10);
          const minFontSize = templateNumberValue(mapping, 'minFontSize', 'min_font_size', 6);
          const fontName = String(templateValue(mapping, 'fontWeight', 'font_weight', '')).toLowerCase() === 'bold'
            ? 'Helvetica-Bold'
            : 'Helvetica';
          drawTableBlock({
            doc,
            mapping,
            pageItems,
            xMm,
            yMm,
            widthMm,
            tableHeightMm: templateNumberValue(mapping, 'tableHeightMm', 'table_height_mm', frameTableHeightMm),
            rowPitchMm: templateNumberValue(mapping, 'rowHeightMm', 'row_height_mm', frameRowPitchMm),
            minRows: frameMinRows,
            fontName,
            fontSize,
            minFontSize,
            textColor: pdfColorForTemplate(templateValue(mapping, 'textColor', 'text_color', 'black')),
            letterSpacing: templateNumberValue(mapping, 'letterSpacing', 'letter_spacing', 0),
            columns: tableColumns,
            displayId,
            printNotes: tablePrintNotes,
          });
          continue;
        }
        if (tableFields.has(fieldKey)) {
          continue;
        }
        if (fieldType === 'IMAGE') {
          const objectKey = String(templateValue(mapping, 'assetObjectKey', 'asset_object_key', '') || '');
          if (!objectKey) {
            continue;
          }
          try {
            const asset = await readS3ObjectBuffer(objectKey);
            doc.image(asset, mmToPdfPoints(xMm), mmToPdfPoints(yMm), {
              width: mmToPdfPoints(widthMm),
              height: mmToPdfPoints(heightMm),
            });
          } catch (_) {}
          continue;
        }

        const fontSize = templateNumberValue(mapping, 'fontSize', 'font_size', 10);
        const minFontSize = templateNumberValue(mapping, 'minFontSize', 'min_font_size', 6);
        const fontName = String(templateValue(mapping, 'fontWeight', 'font_weight', '')).toLowerCase() === 'bold'
          ? 'Helvetica-Bold'
          : 'Helvetica';
        const alignment = templateValue(mapping, 'alignment', 'alignment', 'left');
        const align = ['left', 'center', 'right'].includes(alignment) ? alignment : 'left';
        const rowPitchMm = templateNumberValue(mapping, 'rowHeightMm', 'row_height_mm', frameRowPitchMm);
        const fitFontSize = tableFields.has(fieldKey)
          ? Math.max(minFontSize, Math.min(fontSize, Math.max(minFontSize, rowPitchMm * 2.2)))
          : fontSize;
        const textOptions = {
          width: mmToPdfPoints(widthMm),
          height: mmToPdfPoints(heightMm),
          align,
          characterSpacing: templateNumberValue(mapping, 'letterSpacing', 'letter_spacing', 0),
          lineBreak: true,
        };
        doc.font(fontName).fontSize(fitFontSize).fillColor(
          pdfColorForTemplate(templateValue(mapping, 'textColor', 'text_color', 'black')),
        );
        const text = fieldType === 'STATIC'
          ? templateValue(mapping, 'fieldValue', 'field_value', '') || ''
          : fields[fieldKey] || '';
        doc.text(
          truncateTemplateText(text, templateNumberValue(mapping, 'maxChars', 'max_chars', 0)),
          mmToPdfPoints(xMm),
          mmToPdfPoints(yMm),
          textOptions,
        );
      }
    };

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
      const pageItems = items.slice(pageIndex * rowsPerPage, pageIndex * rowsPerPage + rowsPerPage);
      for (const frame of frames) {
        await drawSingleChallan(pageItems, frame);
      }
      drawCutGuides();
    }
    doc.end();
    return finished;
  }

  const ALLOWED_CHALLAN_TEMPLATE_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
  ]);

  function normalizeChallanTemplateFileName(fileName) {
    const baseName = path.basename(String(fileName || '').trim());
    return baseName
      .replace(/[^\w.\- ()]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 160) || 'challan-template';
  }

  function assertValidChallanTemplateUploadInput({
    uploadType,
    fileName,
    contentType,
    sizeBytes,
    sha256,
  }) {
    const normalizedUploadType = normalizeUploadType(uploadType);
    const normalizedContentType = String(contentType || '').toLowerCase().trim();
    const normalizedSize = Number(sizeBytes || 0);
    const normalizedSha = String(sha256 || '').toLowerCase().trim();
    const normalizedName = normalizeChallanTemplateFileName(fileName);

    if (
      normalizedUploadType !== 'CHALLAN_TEMPLATE_BACKGROUND' &&
      normalizedUploadType !== 'CHALLAN_TEMPLATE_STAMP'
    ) {
      const error = new Error(
        'Challan template uploads must declare a supported challan template upload type.',
      );
      error.statusCode = 400;
      throw error;
    }
    if (
      normalizedUploadType === 'CHALLAN_TEMPLATE_STAMP' &&
      normalizedContentType !== 'image/png'
    ) {
      const error = new Error('Challan stamps and signatures must be transparent PNG files.');
      error.statusCode = 400;
      throw error;
    }
    if (
      normalizedUploadType === 'CHALLAN_TEMPLATE_BACKGROUND' &&
      !ALLOWED_CHALLAN_TEMPLATE_CONTENT_TYPES.has(normalizedContentType)
    ) {
      const error = new Error('Only PNG, JPG, and JPEG template scans are allowed.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isFinite(normalizedSize) || normalizedSize <= 0) {
      const error = new Error('File size must be greater than zero.');
      error.statusCode = 400;
      throw error;
    }
    if (normalizedSize > 15 * 1024 * 1024) {
      const error = new Error('Challan template scans must be 15 MB or smaller.');
      error.statusCode = 400;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(normalizedSha)) {
      const error = new Error('A valid SHA-256 file hash is required.');
      error.statusCode = 400;
      throw error;
    }

    return {
      uploadType: normalizedUploadType,
      fileName: normalizedName,
      contentType: normalizedContentType,
      sizeBytes: Math.round(normalizedSize),
      sha256: normalizedSha,
    };
  }

  async function createChallanTemplateUploadIntent(input) {
    const normalized = assertValidChallanTemplateUploadInput(input || {});
    if (normalized.uploadType === 'CHALLAN_TEMPLATE_BACKGROUND') {
      const reusable = await findReusableChallanTemplateUpload(normalized);
      if (reusable) {
        const scan = await rowToChallanTemplateScanDto(reusable);
        if (scan.canvasWidth > 0 && scan.canvasHeight > 0) {
          return {
            uploadSessionId: '',
            objectKey: scan.objectKey,
            uploadUrl: '',
            expiresAt: null,
            headers: {},
            reused: true,
            canvasWidth: scan.canvasWidth,
            canvasHeight: scan.canvasHeight,
            fileName: scan.fileName,
            contentType: scan.contentType,
            sizeBytes: scan.sizeBytes,
            sha256: scan.sha256,
          };
        }
      }
    }
    const objectKey = buildS3ObjectKey({
      uploadType: normalized.uploadType,
      fileName: normalized.fileName,
      sha256: normalized.sha256,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const uploadSessionId = `challan-template-upload-${now.getTime()}-${crypto
      .randomBytes(8)
      .toString('hex')}`;
    await run(
      `
      INSERT INTO challan_template_upload_sessions (
        id, file_name, content_type, size_bytes, sha256, upload_type, object_key, status, expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `,
      [
        uploadSessionId,
        normalized.fileName,
        normalized.contentType,
        normalized.sizeBytes,
        normalized.sha256,
        normalized.uploadType,
        objectKey,
        expiresAt,
        now.toISOString(),
      ],
    );

    return {
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
      reused: false,
      canvasWidth: 0,
      canvasHeight: 0,
    };
  }

  async function findReusableChallanTemplateUpload(normalized) {
    const prefix = getS3Prefix(normalized.uploadType);
    return get(
      `
      SELECT *
      FROM challan_template_upload_sessions
      WHERE status = 'completed'
        AND sha256 = ?
        AND object_key LIKE ?
      ORDER BY datetime(completed_at) DESC, id DESC
      LIMIT 1
      `,
      [normalized.sha256, `${prefix}%`],
    );
  }

  async function ensureChallanTemplateScanDimensions(row) {
    const canvasWidth = Number(row.canvas_width || 0);
    const canvasHeight = Number(row.canvas_height || 0);
    if (canvasWidth > 0 && canvasHeight > 0) {
      return { canvasWidth, canvasHeight };
    }
    try {
      const buffer = await readS3ObjectBuffer(row.object_key);
      const dimensions = imageSize(buffer);
      const width = Number(dimensions.width || 0);
      const height = Number(dimensions.height || 0);
      if (width > 0 && height > 0) {
        await run(
          'UPDATE challan_template_upload_sessions SET canvas_width = ?, canvas_height = ? WHERE id = ?',
          [width, height, row.id],
        );
        return { canvasWidth: width, canvasHeight: height };
      }
    } catch (_) {}
    return { canvasWidth: 0, canvasHeight: 0 };
  }

  async function rowToChallanTemplateScanDto(row) {
    const dimensions = await ensureChallanTemplateScanDimensions(row);
    let imageUrl = null;
    try {
      imageUrl = (await assetReadUrlPayload(row.object_key)).readUrl;
    } catch (_) {
      imageUrl = null;
    }
    return {
      uploadSessionId: row.id || '',
      objectKey: row.object_key || '',
      fileName: row.file_name || '',
      contentType: row.content_type || '',
      sizeBytes: Number(row.size_bytes || 0),
      sha256: row.sha256 || '',
      canvasWidth: dimensions.canvasWidth,
      canvasHeight: dimensions.canvasHeight,
      imageUrl,
      uploadedAt: row.completed_at || row.created_at || null,
    };
  }

  async function listChallanTemplateScans({ limit = 24 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 24)));
    const prefix = S3_UPLOAD_PREFIXES.CHALLAN_TEMPLATE_BACKGROUND;
    const rows = await all(
      `
      SELECT *
      FROM challan_template_upload_sessions
      WHERE status = 'completed'
        AND object_key LIKE ?
      ORDER BY datetime(completed_at) DESC, id DESC
      LIMIT ?
      `,
      [`${prefix}%`, safeLimit],
    );
    return Promise.all(rows.map((row) => rowToChallanTemplateScanDto(row)));
  }

  async function completeChallanTemplateUpload({ uploadSessionId, objectKey }) {
    const session = await get(
      'SELECT * FROM challan_template_upload_sessions WHERE id = ?',
      [uploadSessionId],
    );
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
    const buffer = await readS3ObjectBuffer(session.object_key);
    const dimensions = imageSize(buffer);
    if (!dimensions.width || !dimensions.height) {
      const error = new Error('Uploaded template scan dimensions could not be read.');
      error.statusCode = 400;
      throw error;
    }
    const now = new Date().toISOString();
    await run(
      "UPDATE challan_template_upload_sessions SET status = 'completed', completed_at = ?, canvas_width = ?, canvas_height = ? WHERE id = ?",
      [now, Number(dimensions.width || 0), Number(dimensions.height || 0), uploadSessionId],
    );
    return {
      uploadSessionId,
      objectKey: session.object_key,
      fileName: session.file_name,
      contentType: session.content_type,
      sizeBytes: Number(session.size_bytes || 0),
      canvasWidth: Number(dimensions.width || 0),
      canvasHeight: Number(dimensions.height || 0),
      uploadedAt: now,
    };
  }

  return {
    rowToChallanTemplateMappingDto,
    rowToChallanTemplateDto,
    normalizeTemplatePartyType,
    normalizeTemplateNumber,
    normalizeTemplateAlignment,
    normalizeTemplateFieldType,
    normalizeTemplatePaperSize,
    normalizeTemplateStockSize,
    normalizeTemplateNUpLayout,
    normalizeTemplateTextColor,
    normalizeTemplateFieldKey,
    normalizeChallanTemplateMappings,
    listChallanTemplates,
    getChallanTemplateRowById,
    saveChallanTemplate,
    deleteChallanTemplate,
    getTemplatePartyForChallan,
    findActiveChallanTemplateForChallan,
    truncateTemplateText,
    challanTemplateScalarFields,
    itemTableValueForField,
    pdfColorForTemplate,
    mmToPdfPoints,
    paperSizeMmForTemplate,
    slotFramesForTemplate,
    resolveStockFrameForSlot,
    validateTemplateSheetLayout,
    layoutFramesForTemplate,
    templateValue,
    templateNumberValue,
    buildChallanTemplateSnapshot,
    templateBoxWidthMm,
    templateBoxHeightMm,
    templateCoordinateMm,
    parseTemplateTableColumns,
    templateTablePrintNotes,
    ensureCoreChallanFieldMappings,
    drawTableBlock,
    buildTemplateTestChallanDto,
    generateChallanTemplatePdf,
    normalizeChallanTemplateFileName,
    assertValidChallanTemplateUploadInput,
    createChallanTemplateUploadIntent,
    findReusableChallanTemplateUpload,
    ensureChallanTemplateScanDimensions,
    rowToChallanTemplateScanDto,
    listChallanTemplateScans,
    completeChallanTemplateUpload,
  };
}

module.exports = { createChallanTemplateService };
