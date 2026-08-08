'use strict';

// ---------------------------------------------------------------------------
// Vendors module — domain service.
//
// The vendor domain logic, moved VERBATIM out of server.js. This is the second
// half of an evacuation: moving routes alone relocates the HTTP surface but
// leaves the module's actual behaviour in the monolith, which is why every
// module's ctx stayed large. Moving the service is what shrinks it.
//
// Dependencies are injected rather than imported, so this file has no reach
// into the monolith at all: db primitives (get/all/run/logChange), two shared
// string normalisers, and the challans port used for a vendor's challan count
// (K5 — vendors must not read delivery_challans directly).
// ---------------------------------------------------------------------------

module.exports = function createVendorsService(ctx) {
  const {
    all,
    challansPorts,
    get,
    logChange,
    normalizeGstNumber,
    normalizePartyValue,
    run,
  } = ctx;

function rowToVendorDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name || '',
    alias: row.alias || '',
    gstNumber: row.gst_number || '',
    address: row.address || '',
    contactName: row.contact_name || '',
    phone: row.phone || '',
    email: row.email || '',
    isArchived: Boolean(row.is_archived),
    usageCount: row.usage_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getVendorRowById(id) {
  // usage_count comes from challans territory, so it is asked for through the
  // challans port and merged back onto the row — callers (display AND the
  // in-use guards) keep seeing the exact same shape.
  const row = await get(
    `
    SELECT
      vendors.*
    FROM vendors
    WHERE vendors.id = ?
    `,
    [id],
  );
  if (!row) return row;
  row.usage_count = await challansPorts.usage.countForVendor(row.id);
  return row;
}

async function getVendorsWithUsage() {
  const rows = await all(`
    SELECT
      vendors.*
    FROM vendors
    ORDER BY vendors.is_archived ASC, LOWER(vendors.name) ASC, vendors.id ASC
  `);
  // ONE batched port call for the whole list — a per-row call here would turn
  // the vendor list into N+1.
  const counts = await challansPorts.usage.countByVendors(rows.map((r) => r.id));
  for (const row of rows) {
    row.usage_count = counts.get(Number(row.id)) || 0;
  }
  return rows;
}

async function getVendorPurchaseHistory(vendorId) {
  // Challans territory — asked through the port (K5).
  return challansPorts.reception.linesForVendor(vendorId);
}

async function findVendorDuplicate({ name, gstNumber = '', excludeId = null }) {
  const rows = await all('SELECT id, name, gst_number FROM vendors');
  const normalizedName = normalizePartyValue(name);
  const normalizedGst = normalizeGstNumber(gstNumber);
  return rows.find((row) => {
    if (excludeId != null && row.id === excludeId) {
      return false;
    }
    const sameName = normalizePartyValue(row.name) === normalizedName;
    const sameGst =
      normalizedGst &&
      normalizeGstNumber(row.gst_number || '') === normalizedGst;
    return sameName || Boolean(sameGst);
  }) || null;
}

async function saveVendor({
  name,
  alias = '',
  gstNumber = '',
  address = '',
  contactName = '',
  phone = '',
  email = '',
  id = null,
}) {
  const trimmedName = String(name || '').trim();
  const trimmedAlias = String(alias || '').trim();
  const trimmedAddress = String(address || '').trim();
  const trimmedContactName = String(contactName || '').trim();
  const trimmedPhone = String(phone || '').trim();
  const trimmedEmail = String(email || '').trim();
  const trimmedGstNumber = normalizeGstNumber(gstNumber);
  if (!trimmedName) {
    const error = new Error('Vendor name is required.');
    error.statusCode = 400;
    throw error;
  }

  const duplicate = await findVendorDuplicate({
    name: trimmedName,
    gstNumber: trimmedGstNumber,
    excludeId: id,
  });
  if (duplicate) {
    const error = new Error('A vendor with the same name or GST number already exists.');
    error.statusCode = 409;
    throw error;
  }

  const now = new Date().toISOString();
  if (id == null) {
    const result = await run(
      `
      INSERT INTO vendors (
        name, alias, gst_number, address, contact_name, phone, email, is_archived, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `,
      [
        trimmedName,
        trimmedAlias,
        trimmedGstNumber,
        trimmedAddress,
        trimmedContactName,
        trimmedPhone,
        trimmedEmail,
        now,
        now,
      ],
    );
    await logChange('vendors', result.lastID, 'INSERT');
    return getVendorRowById(result.lastID);
  }

  const existing = await getVendorRowById(id);
  if (!existing) {
    const error = new Error('Vendor not found.');
    error.statusCode = 404;
    throw error;
  }

  await run(
    `
    UPDATE vendors
    SET name = ?, alias = ?, gst_number = ?, address = ?, contact_name = ?, phone = ?, email = ?, updated_at = ?
    WHERE id = ?
    `,
    [
      trimmedName,
      trimmedAlias,
      trimmedGstNumber,
      trimmedAddress,
      trimmedContactName,
      trimmedPhone,
      trimmedEmail,
      now,
      id,
    ],
  );
  await logChange('vendors', id, 'UPDATE');
  return getVendorRowById(id);
}
  return {
    rowToVendorDto,
    getVendorRowById,
    getVendorsWithUsage,
    getVendorPurchaseHistory,
    findVendorDuplicate,
    saveVendor,
  };
};
