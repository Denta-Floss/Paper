'use strict';

const partyContacts = require('../parties/contacts');
const { normalizePartyValue, normalizeGstNumber } = require('../parties/party-kit');

// ---------------------------------------------------------------------------
// The client master: reading it, shaping it for the wire, the one save, archive
// and restore, and the sub-contractors that hang off a client.
//
// Takes {get, all, run, logChange} plus the orders port. A client's usage_count
// is the number of order lines naming it, and whether a client is "locked" to
// its name and GST depends on how many of those lines are live. Both live in
// the orders module's table, so the counts come through `orders`, not from a
// join here.
//
// Archive and restore do not know about HTTP. They return what the route needs
// to answer ({notFound}, {already}, or the before/after rows) and throw the
// 409 with its `code` for a client that something still names.
// ---------------------------------------------------------------------------

function createClientService({ get, all, run, logChange, desk }) {
  function rowToClientDto(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name || '',
      alias: row.alias || '',
      gstNumber: row.gst_number || '',
      address: row.address || '',
      // The person you ring FIRST about this company. Since 056 these four are a
      // mirror of the primary row in party_contacts, kept by
      // modules/parties/contacts.js — `contacts` below is everyone.
      // Distinct from this client's sub-contractors, who are parties you give
      // work TO; the same human may legitimately appear in both.
      contactName: row.contact_name || '',
      designation: row.designation || '',
      phone: row.phone || '',
      email: row.email || '',
      // Hung on the row by attachClientContacts — one query for any number of
      // clients. A row read without it lists nobody rather than failing.
      contacts: Array.isArray(row.contacts) ? row.contacts : [],
      logoUrl: row.logo_url || '',
      photoUrl: row.photo_url || '',
      isArchived: Boolean(row.is_archived),
      usageCount: row.usage_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function getClientRowById(id) {
    const row = await get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!row) {
      return row;
    }
    const { count } = await desk.ask('orders.clients.lineCount', { clientId: row.id });
    return { ...row, usage_count: count };
  }

  async function getClientsWithUsage() {
    const rows = await all(`
      SELECT * FROM clients
      ORDER BY is_archived ASC, LOWER(name) ASC
    `);
    const { counts } = await desk.ask('orders.clients.lineCounts');
    return rows.map((row) => ({ ...row, usage_count: counts[row.id] || 0 }));
  }

  async function findClientDuplicate({ name, gstNumber = '', excludeId = null }) {
    const rows = await all('SELECT id, name, gst_number FROM clients');
    const normalizedName = normalizePartyValue(name);
    const normalizedGst = normalizeGstNumber(gstNumber);
    return rows.find((row) => {
      if (excludeId != null && row.id === excludeId) {
        return false;
      }
      if (normalizePartyValue(row.name) === normalizedName) {
        return true;
      }
      return normalizedGst && normalizeGstNumber(row.gst_number) === normalizedGst;
    }) || null;
  }

  // Every field but the name is undefined-preserving, and has to be: the PATCH
  // route spreads the request body straight in (`{...req.body, id}`), and four
  // internal callers mention only what they happen to know. Defaulting the rest
  // to '' meant a PATCH about a phone number blanked the address — exactly the
  // photo_url bug, one table over.
  //
  // logoUrl and photoUrl are stored in clients.logo_url / photo_url (migration
  // 030). They used to be accepted and dropped under a comment saying the table
  // had no column for either — it has had both since 030, so a logo uploaded in
  // the editor showed "saved" and was blank on reopen.
  async function saveClient({
    name,
    alias,
    gstNumber,
    address,
    // The company's primary contact (migrations/047) — one person, answered here
    // and shown on every part developed for them.
    contactName,
    designation,
    phone,
    email,
    logoUrl,
    photoUrl,
    id = null,
  }) {
    // Read before anything else, so "what is already stored" is the fallback for
    // every field the caller left out — including the two checks below, which
    // would otherwise compare against a blank.
    const existing = id == null ? null : await getClientRowById(id);
    if (id != null && !existing) {
      const error = new Error('Client not found.');
      error.statusCode = 404;
      throw error;
    }

    const kept = (value, column) =>
      value !== undefined ? String(value || '').trim() : String(existing?.[column] || '');

    const trimmedName = kept(name, 'name');
    const trimmedAlias = kept(alias, 'alias');
    const trimmedAddress = kept(address, 'address');
    const trimmedContactName = kept(contactName, 'contact_name');
    const trimmedDesignation = kept(designation, 'designation');
    const trimmedPhone = kept(phone, 'phone');
    const trimmedEmail = kept(email, 'email');
    const trimmedLogoUrl = kept(logoUrl, 'logo_url');
    const trimmedPhotoUrl = kept(photoUrl, 'photo_url');
    const trimmedGstNumber =
      gstNumber !== undefined
        ? normalizeGstNumber(gstNumber)
        : normalizeGstNumber(existing?.gst_number || '');

    if (!trimmedName) {
      // 400, not the 500 a bare Error threw here before: a missing name is the
      // caller's mistake and the form has to be told so. saveVendor already does
      // it this way.
      const error = new Error('name is required.');
      error.statusCode = 400;
      throw error;
    }
    if (trimmedGstNumber && trimmedGstNumber.length !== 15) {
      const error = new Error('GST number must be 15 characters.');
      error.statusCode = 400;
      throw error;
    }

    const duplicate = await findClientDuplicate({
      name: trimmedName,
      gstNumber: trimmedGstNumber,
      excludeId: id,
    });
    if (duplicate) {
      const duplicateByName =
        normalizePartyValue(duplicate.name) === normalizePartyValue(trimmedName);
      const error = new Error(
        duplicateByName
          ? 'A client with the same name already exists.'
          : 'A client with the same GST number already exists.',
      );
      error.statusCode = 409;
      throw error;
    }

    const now = new Date().toISOString();
    // The client row and its primary contact land together or not at all. A
    // SAVEPOINT rather than BEGIN, because this also runs inside callers that
    // already hold a transaction, where BEGIN would fail.
    const together = async (work) => {
      await run('SAVEPOINT save_client');
      try {
        const out = await work();
        await run('RELEASE save_client');
        return out;
      } catch (error) {
        await run('ROLLBACK TO save_client').catch(() => {});
        await run('RELEASE save_client').catch(() => {});
        throw error;
      }
    };

    if (id == null) {
      const newId = await together(async () => {
      const result = await run(
        `
        INSERT INTO clients (name, alias, gst_number, address, contact_name, designation, phone, email, logo_url, photo_url, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
        [
          trimmedName,
          trimmedAlias,
          trimmedGstNumber,
          trimmedAddress,
          trimmedContactName,
          trimmedDesignation,
          trimmedPhone,
          trimmedEmail,
          trimmedLogoUrl,
          trimmedPhotoUrl,
          now,
          now,
        ],
      );
      // The form's one person lands on the company's primary contact (056).
      await partyContacts.syncPrimaryFromFlat({ get, all, run }, result.lastID, {
        contactName,
        designation,
        phone,
        email,
      });
      return result.lastID;
      });
      await logChange('clients', newId, 'INSERT');
      return getClientRowById(newId);
    }

    if ((existing.usage_count || 0) > 0) {
      const { count: lockedOrderUsage } = await desk.ask('orders.clients.lockedLineCount', { clientId: id });
      // Name and GST only. A contact person, their designation, phone or email
      // are not the client's legal identity — those are the facts most likely to
      // change on a client you are actively working with, and locking them would
      // make the Contact card unusable precisely where it matters.
      const identityChanged =
        normalizePartyValue(existing.name) !== normalizePartyValue(trimmedName) ||
        normalizeGstNumber(existing.gst_number) !== trimmedGstNumber;
      if (identityChanged && lockedOrderUsage > 0) {
        const error = new Error('Used clients cannot change name or GST number.');
        error.statusCode = 409;
        throw error;
      }
    }

    await together(async () => {
    await run(
      'UPDATE clients SET name = ?, alias = ?, gst_number = ?, address = ?, contact_name = ?, designation = ?, phone = ?, email = ?, logo_url = ?, photo_url = ?, updated_at = ? WHERE id = ?',
      [
        trimmedName,
        trimmedAlias,
        trimmedGstNumber,
        trimmedAddress,
        trimmedContactName,
        trimmedDesignation,
        trimmedPhone,
        trimmedEmail,
        trimmedLogoUrl,
        trimmedPhotoUrl,
        now,
        id,
      ],
    );
    // Only the fields the caller sent: a PATCH about the address leaves the
    // primary contact exactly as it was.
    await partyContacts.syncPrimaryFromFlat({ get, all, run }, id, {
      contactName,
      designation,
      phone,
      email,
    });
    });
    await logChange('clients', id, 'UPDATE');
    return getClientRowById(id);
  }

  /// Archive a client. A client something still names cannot be archived: it
  /// would leave those lines without one.
  async function archiveClient(id) {
    const client = await get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!client) {
      return { notFound: true };
    }
    if (Number(client.is_archived || 0) === 1) {
      // Already there. Answering with the row rather than refusing keeps two
      // clients racing the same button from showing one of them an error.
      await partyContacts.attachClientContacts({ all }, client);
      return { already: true, row: client };
    }
    const { count: orderLines } = await desk.ask('orders.clients.lineCount', { clientId: id });
    const subContractors = Number(
      (await get('SELECT COUNT(*) AS c FROM sub_contractors WHERE client_id = ?', [id]))?.c || 0,
    );
    const blockers = [];
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    if (orderLines > 0) {
      blockers.push(plural(orderLines, 'order line'));
    }
    if (subContractors > 0) {
      blockers.push(plural(subContractors, 'sub-contractor'));
    }
    if (blockers.length > 0) {
      // It used to refuse with the bare words "Client is in use", which told
      // nobody what to go and look at.
      const error = new Error(
        `"${client.name}" is still named on ${blockers.join(' and ')}. `
        + 'Archiving it would leave those without a client.',
      );
      error.statusCode = 409;
      error.code = 'client_in_use';
      throw error;
    }
    await run('UPDATE clients SET is_archived = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    const after = await get('SELECT * FROM clients WHERE id = ?', [id]);
    await partyContacts.attachClientContacts({ all }, after);
    return { before: client, row: after };
  }

  /// Archive was a one-way door: there was no route back, so a client archived by
  /// mistake could only be fixed in the database.
  async function unarchiveClient(id) {
    const client = await get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!client) {
      return { notFound: true };
    }
    await run('UPDATE clients SET is_archived = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    const after = await get('SELECT * FROM clients WHERE id = ?', [id]);
    await partyContacts.attachClientContacts({ all }, after);
    return { before: client, row: after };
  }

  function rowToSubContractorDto(row) {
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      // So a contractor answers the same four questions a client's contact does
      // (migrations/047) — a part developed for one prints their designation.
      designation: row.designation || '',
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      gstNumber: row.gst_number,
      address: row.address,
      photoUrl: row.photo_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clientName: row.client_name,
    };
  }

  async function subContractorsTableExists() {
    return Boolean(await get('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'sub_contractors\''));
  }

  /// Every sub-contractor, with the client each works for.
  async function listSubContractors() {
    if (!(await subContractorsTableExists())) {
      return [];
    }
    const dataRows = await all(`
      SELECT s.*, c.name as client_name 
      FROM sub_contractors s
      LEFT JOIN clients c ON s.client_id = c.id
      ORDER BY s.name ASC
    `);
    return dataRows.map(rowToSubContractorDto);
  }

  async function listSubContractorsForClient(clientId) {
    if (!(await subContractorsTableExists())) {
      return [];
    }
    const dataRows = await all('SELECT * FROM sub_contractors WHERE client_id = ? ORDER BY name ASC', [clientId]);
    return dataRows.map(rowToSubContractorDto);
  }

  async function createSubContractor(clientId, body) {
    const { name, designation, phone, email, notes, gstNumber, address, photoUrl } = body || {};

    if (!name || !String(name).trim()) {
      return { refusal: { status: 400, body: { success: false, error: 'Name is required' } } };
    }

    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO sub_contractors (client_id, name, designation, phone, email, notes, gst_number, address, photo_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, String(name).trim(), designation || '', phone || '', email || '', notes || '', gstNumber || '', address || '', photoUrl || '', now, now]
    );

    const row = await get('SELECT * FROM sub_contractors WHERE id = ?', [result.lastID]);
    return { id: result.lastID, row, dto: rowToSubContractorDto(row) };
  }

  async function updateSubContractor(id, body) {
    const { name, designation, phone, email, notes, gstNumber, address, photoUrl } = body || {};

    if (!name || !String(name).trim()) {
      return { refusal: { status: 400, body: { success: false, error: 'Name is required' } } };
    }

    // Read first: UpdateSubContractorInput omits every field the form did not
    // touch, and this route used to write all of them with `|| ''` — so a PATCH
    // about a phone number blanked the GST, the address and the photo. Same
    // undefined-preserving contract as saveClient and saveItem.
    const existing = await get('SELECT * FROM sub_contractors WHERE id = ?', [id]);
    if (!existing) {
      return { refusal: { status: 404, body: { success: false, error: 'Not found' } } };
    }
    const kept = (value, column) =>
      value !== undefined ? String(value || '').trim() : String(existing[column] || '');

    const now = new Date().toISOString();
    await run(
      `UPDATE sub_contractors 
       SET name = ?, designation = ?, phone = ?, email = ?, notes = ?, gst_number = ?, address = ?, photo_url = ?, updated_at = ?
       WHERE id = ?`,
      [
        String(name).trim(),
        kept(designation, 'designation'),
        kept(phone, 'phone'),
        kept(email, 'email'),
        kept(notes, 'notes'),
        kept(gstNumber, 'gst_number'),
        kept(address, 'address'),
        kept(photoUrl, 'photo_url'),
        now,
        id,
      ]
    );

    const row = await get('SELECT * FROM sub_contractors WHERE id = ?', [id]);
    if (!row) {
      return { refusal: { status: 404, body: { success: false, error: 'Not found' } } };
    }
    return { existing, row, dto: rowToSubContractorDto(row) };
  }

  /// Read before the row is gone — trackDelete needs it for the label, and a
  /// DELETE here is permanent (no trashAndDelete, so nothing reaches the
  /// Action Center to recover the name from).
  async function deleteSubContractor(id) {
    const before = await get('SELECT * FROM sub_contractors WHERE id = ?', [id]);
    await run('DELETE FROM sub_contractors WHERE id = ?', [id]);
    return before;
  }

  return {
    rowToClientDto,
    rowToSubContractorDto,
    getClientRowById,
    getClientsWithUsage,
    findClientDuplicate,
    saveClient,
    archiveClient,
    unarchiveClient,
    listSubContractors,
    listSubContractorsForClient,
    createSubContractor,
    updateSubContractor,
    deleteSubContractor,
  };
}

module.exports = { createClientService };
