'use strict';

// ---------------------------------------------------------------------------
// The trash: what a delete leaves behind, and bringing it back.
//
// trashAndDelete is how every module deletes a row it wants to be recoverable:
// the row is copied to deleted_records (as JSON, with who and when), then removed
// on the dedicated delete connection, which runs with foreign keys OFF. That is
// deliberate. It lets a row go even when something still points at it, and the
// dangling reference then shows up in the action center's integrity scan rather
// than blocking the delete.
//
// Takes {get, all, run} on the main connection, `runOnDelete` for the
// foreign-keys-off connection (which stays in server.js: initDb, closeDb and the
// tests depend on it), `logChange` so connected clients refresh, and
// `restoreEntityAssets`, which brings a record's photos back with it.
//
// Restore does not know about HTTP: it returns {refusal:{status,body}} for the
// cases the caller must answer with a 4xx, or {restored:{tableName,recordId}}.
// ---------------------------------------------------------------------------

// Tables whose rows can be recovered from the trash. Kept explicit so a
// client-supplied tableName can never be interpolated into SQL unchecked.
const RESTORABLE_TABLES = new Set([
  'clients', 'vendors', 'units', 'items', 'groups', 'departments', 'employees',
  'item_variations', 'item_variation_nodes', 'item_unit_conversions', 'uploaded_assets',
]);

function createTrashService({ get, all, run, runOnDelete, logChange, restoreEntityAssets }) {
  async function trashAndDelete(tableName, recordId, req) {
    const deletedBy = req?.user?.name || 'System';

    // Fetch the row
    const row = await get(`SELECT * FROM ${tableName} WHERE id = ?`, [recordId]);
    if (!row) return;

    // Insert into trash
    const trash = await run(
      `INSERT INTO deleted_records (table_name, record_id, data_json, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [tableName, recordId, JSON.stringify(row), new Date().toISOString(), deletedBy]
    );

    // Delete via the dedicated FK-off connection (see deleteDb).
    try {
      await runOnDelete(`DELETE FROM ${tableName} WHERE id = ?`, [recordId]);
    } catch (err) {
      // Compensate so a failed delete never strands an unrecoverable trash row.
      await run('DELETE FROM deleted_records WHERE id = ?', [trash.lastID]).catch(() => {});
      throw err;
    }

    await logChange(tableName, recordId, 'DELETE');
  }

  async function trashAndDeleteMany(tableName, recordIds, req) {
    if (!recordIds || recordIds.length === 0) return;
    const deletedBy = req?.user?.name || 'System';
    const now = new Date().toISOString();
    // Chunk to stay well under SQLite's default 999 bound-variable limit so a
    // parent with a very large child set (e.g. 1000+ variation nodes) still deletes.
    const CHUNK = 400;

    for (let i = 0; i < recordIds.length; i += CHUNK) {
      const chunk = recordIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await all(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`, chunk);
      if (rows.length === 0) continue;

      const trashIds = [];
      for (const row of rows) {
        const trash = await run(
          `INSERT INTO deleted_records (table_name, record_id, data_json, deleted_at, deleted_by)
           VALUES (?, ?, ?, ?, ?)`,
          [tableName, row.id, JSON.stringify(row), now, deletedBy]
        );
        trashIds.push(trash.lastID);
      }

      try {
        await runOnDelete(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`, chunk);
      } catch (err) {
        const trashPlaceholders = trashIds.map(() => '?').join(',');
        await run(`DELETE FROM deleted_records WHERE id IN (${trashPlaceholders})`, trashIds).catch(() => {});
        throw err;
      }

      for (const row of rows) {
        await logChange(tableName, row.id, 'DELETE');
      }
    }
  }

  /// Trashed records, most recent first, optionally for one table.
  async function listTrash(tableName) {
    const params = [];
    let where = '';
    if (tableName) {
      where = 'WHERE table_name = ?';
      params.push(String(tableName));
    }
    const rows = await all(
      `SELECT id, table_name, record_id, data_json, deleted_at, deleted_by
       FROM deleted_records ${where} ORDER BY id DESC LIMIT 500`,
      params
    );
    return rows.map((r) => {
      let data = null;
      try {
        data = JSON.parse(r.data_json);
      } catch (_) {
        data = null;
      }
      return {
        id: r.id,
        tableName: r.table_name,
        recordId: r.record_id,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
        label: (data && (data.display_name || data.name || data.challan_no)) || `${r.table_name} #${r.record_id}`,
        data,
      };
    });
  }

  // Re-insert a trashed row (original id preserved) and remove it from the trash.
  // Uses a plain INSERT (never OR REPLACE) so a live row is never silently
  // clobbered; FK checks are skipped so a row can be restored even if some of its
  // own references are still missing (those resurface in the Action Center).
  async function restore(tableName, recordId) {
    if (!tableName || !Number.isFinite(recordId)) {
      return { refusal: { status: 400, body: { success: false, error: 'tableName and recordId are required.' } } };
    }
    if (!RESTORABLE_TABLES.has(tableName)) {
      return { refusal: { status: 400, body: { success: false, error: `Table "${tableName}" is not restorable.` } } };
    }

    const rec = await get(
      `SELECT * FROM deleted_records WHERE table_name = ? AND record_id = ? ORDER BY id DESC LIMIT 1`,
      [tableName, recordId]
    );
    if (!rec) {
      return { refusal: { status: 404, body: { success: false, error: 'No trashed record found for that table and id.' } } };
    }

    // Never clobber a live row that already occupies this id.
    const live = await get(`SELECT id FROM ${tableName} WHERE id = ?`, [recordId]);
    if (live) {
      return { refusal: { status: 409, body: { success: false, error: `A live ${tableName} record with id ${recordId} already exists.` } } };
    }

    let data;
    try {
      data = JSON.parse(rec.data_json);
    } catch (_) {
      return { refusal: { status: 422, body: { success: false, error: 'Trashed record data is corrupt and cannot be restored.' } } };
    }
    const cols = Object.keys(data || {});
    if (cols.length === 0) {
      return { refusal: { status: 422, body: { success: false, error: 'Trashed record has no columns to restore.' } } };
    }
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const values = cols.map((c) => data[c]);

    // Insert on the dedicated FK-off connection so a row can be restored even
    // while some of its own references are still missing (they resurface in the
    // Action Center) without touching FK enforcement on the main connection.
    try {
      await runOnDelete(`INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`, values);
    } catch (insertErr) {
      const msg = String((insertErr && insertErr.message) || insertErr);
      // Turn the common recoverable failures into clean 4xx responses instead of
      // a raw 500: a non-PK UNIQUE collision, or a column that no longer exists
      // because a migration changed the table since the row was trashed.
      if (/UNIQUE constraint/i.test(msg)) {
        return { refusal: { status: 409, body: { success: false, error: `Cannot restore: it conflicts with an existing record. (${msg})` } } };
      }
      if (/no column named|has no column/i.test(msg)) {
        return { refusal: { status: 422, body: { success: false, error: `Cannot restore: this table's structure changed since the record was deleted. (${msg})` } } };
      }
      return { refusal: { status: 422, body: { success: false, error: `Restore failed: ${msg}` } } };
    }

    // Remove every trash entry for this record (there may be more than one).
    await run(`DELETE FROM deleted_records WHERE table_name = ? AND record_id = ?`, [tableName, recordId]);
    // Its photos come back with it (they were kept for this).
    await restoreEntityAssets(tableName, recordId);

    await logChange(tableName, recordId, 'INSERT');

    return { restored: { tableName, recordId } };
  }

  return { trashAndDelete, trashAndDeleteMany, listTrash, restore };
}

module.exports = { createTrashService, RESTORABLE_TABLES };
