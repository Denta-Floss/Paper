'use strict';

const { normalizePartyValue, normalizeGstNumber } = require('../parties/party-kit');

// ---------------------------------------------------------------------------
// The vendor master: reading it, shaping it for the wire, and the one save.
//
// Takes only {get, all, run, logChange} plus the challans port. A vendor's
// usage_count is the number of challans naming it; that table belongs to the
// challans module, so the count comes through `challans`, not from a join here.
// ---------------------------------------------------------------------------

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
    logoUrl: row.logo_url || '',
    photoUrl: row.photo_url || '',
    isArchived: Boolean(row.is_archived),
    usageCount: row.usage_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createVendorService({ get, all, run, logChange, challans }) {
  async function getVendorRowById(id) {
    const row = await get('SELECT * FROM vendors WHERE id = ?', [id]);
    if (!row) {
      return row;
    }
    return { ...row, usage_count: await challans.vendorUsageCount(row.id) };
  }

  async function getVendorsWithUsage() {
    const rows = await all(`
      SELECT * FROM vendors
      ORDER BY is_archived ASC, LOWER(name) ASC, id ASC
    `);
    const usage = await challans.vendorUsageCounts();
    return rows.map((row) => ({ ...row, usage_count: usage.get(row.id) || 0 }));
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
    // Absent keeps what is stored (the update reads it below); '' clears.
    logoUrl,
    photoUrl,
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
          name, alias, gst_number, address, contact_name, phone, email, logo_url, photo_url, is_archived, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
        [
          trimmedName,
          trimmedAlias,
          trimmedGstNumber,
          trimmedAddress,
          trimmedContactName,
          trimmedPhone,
          trimmedEmail,
          String(logoUrl || '').trim(),
          String(photoUrl || '').trim(),
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
      SET name = ?, alias = ?, gst_number = ?, address = ?, contact_name = ?, phone = ?, email = ?, logo_url = ?, photo_url = ?, updated_at = ?
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
        logoUrl !== undefined ? String(logoUrl || '').trim() : (existing.logo_url || ''),
        photoUrl !== undefined ? String(photoUrl || '').trim() : (existing.photo_url || ''),
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
    findVendorDuplicate,
    saveVendor,
  };
}

module.exports = { createVendorService, rowToVendorDto };
