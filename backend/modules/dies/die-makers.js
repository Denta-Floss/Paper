'use strict';

// ---------------------------------------------------------------------------
// Die makers — the master behind "Die Made By".
//
//   GET    /api/die-makers            the list, archived last
//   GET    /api/die-makers/:id        one
//   POST   /api/die-makers            create
//   PATCH  /api/die-makers/:id        update
//   DELETE /api/die-makers/:id        archive, or delete when nothing uses it
//
// PERMISSIONS. This is NOT its own module. A die maker is part of die tooling,
// so every route here is gated by dies.read / dies.create / dies.update /
// dies.delete, and `die-makers` is declared alongside `dies` in
// moduleOpForRequest. That declaration is load-bearing: an undeclared first
// path segment maps to no module, which skips the per-module CRUD check
// entirely rather than failing closed.
//
// THE WORK is createDieMakerService below: each function answers a result
// ({ ok, … } or { ok: false, status, error, … }) and knows nothing of HTTP. It
// is published at the kernel desk as dies.makers.* (./operations.js), and the
// routes at the foot of this file ask the desk.
//
// SHAPE. Column for column this is `clients` — the shop asked for the client
// form's fields, and an outside toolroom is a company you invoice. Only `name`
// is required; a die made by a fitter on the floor has no GST number, and
// migration 048 was right about that much even though its conclusion is
// reversed. See 055-die-makers.sql.
// ---------------------------------------------------------------------------

const DIE_MAKER_COLUMNS = [
  'name',
  'alias',
  'gst_number',
  'address',
  'contact_name',
  'designation',
  'phone',
  'email',
  'logo_url',
  'photo_url',
];

/// camelCase in, snake_case out. The payload field for each column.
const FIELD_FOR_COLUMN = {
  name: 'name',
  alias: 'alias',
  gst_number: 'gstNumber',
  address: 'address',
  contact_name: 'contactName',
  designation: 'designation',
  phone: 'phone',
  email: 'email',
  logo_url: 'logoUrl',
  photo_url: 'photoUrl',
};

function rowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    alias: row.alias || '',
    gstNumber: row.gst_number || '',
    address: row.address || '',
    contactName: row.contact_name || '',
    designation: row.designation || '',
    phone: row.phone || '',
    email: row.email || '',
    logoUrl: row.logo_url || '',
    photoUrl: row.photo_url || '',
    isArchived: row.is_archived === 1,
    usageCount: Number(row.usage_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A GST number is fifteen characters or it is not one.
//
// The same rule the client form applies, restated here because the client
// form is a Flutter widget and this is the only thing a portal or an import
// would pass through. A blank is fine — most die makers will not have one.
function gstComplaint(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed.length !== 15) {
    return 'A GST number is 15 characters.';
  }
  return null;
}

function createDieMakerService({ get, all, run }) {
  /// Every maker, with how many dies name it.
  ///
  /// The count is what makes a delete safe to offer: a maker nothing points at
  /// can go, and one that is on forty dies is archived instead.
  const LIST_SQL = `
    SELECT m.*, (
      SELECT COUNT(*) FROM dies d WHERE d.die_maker_id = m.id
    ) AS usage_count
    FROM die_makers m
  `;
  const NOT_FOUND = { ok: false, status: 404, error: 'No such die maker.' };
  const duplicate = (error, detail = {}) => ({
    ok: false,
    status: 409,
    error,
    code: 'die_maker_duplicate',
    ...detail,
  });
  const isUniqueClash = (error) => String(error?.message || '').includes('UNIQUE constraint failed');

  async function list({ includeArchived = false } = {}) {
    const rows = await all(
      `${LIST_SQL}
       ${includeArchived ? '' : 'WHERE m.is_archived = 0'}
       ORDER BY m.is_archived ASC, m.name COLLATE NOCASE ASC`,
    );
    return { ok: true, dieMakers: rows.map(rowToDto) };
  }

  async function getOne(id) {
    const row = await get(`${LIST_SQL} WHERE m.id = ?`, [Number(id)]);
    if (!row) return NOT_FOUND;
    return { ok: true, dieMaker: rowToDto(row) };
  }

  async function create(body = {}) {
    try {
      const name = String(body.name || '').trim();
      if (!name) {
        return { ok: false, status: 400, error: 'A die maker needs a name.' };
      }

      const gstError = gstComplaint(body.gstNumber);
      if (gstError) return { ok: false, status: 400, error: gstError };

      // Checked before the insert so the answer names the maker rather than an
      // index. The unique index is still the guard that actually holds.
      const clash = await get(
        'SELECT id, name FROM die_makers WHERE name = ? COLLATE NOCASE',
        [name],
      );
      if (clash) {
        return duplicate(`"${clash.name}" is already a die maker.`, { dieMakerId: clash.id });
      }

      const now = new Date().toISOString();
      const values = DIE_MAKER_COLUMNS.map((column) =>
        column === 'name' ? name : String(body[FIELD_FOR_COLUMN[column]] || '').trim(),
      );
      const result = await run(
        `INSERT INTO die_makers (${DIE_MAKER_COLUMNS.join(', ')}, created_at, updated_at)
         VALUES (${DIE_MAKER_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
        [...values, now, now],
      );

      const row = await get(`${LIST_SQL} WHERE m.id = ?`, [result.lastID]);
      // The ROW travels too: Track reads it to title the entry.
      return { ok: true, dieMaker: rowToDto(row), id: result.lastID, row };
    } catch (error) {
      if (isUniqueClash(error)) return duplicate('That die maker already exists.');
      throw error;
    }
  }

  async function update(id, body = {}) {
    try {
      const existing = await get('SELECT * FROM die_makers WHERE id = ?', [id]);
      if (!existing) return NOT_FOUND;

      const gstError = gstComplaint(body.gstNumber);
      if (gstError) return { ok: false, status: 400, error: gstError };

      // Absent means leave alone; present-and-empty means clear. The
      // difference matters because this editor is also opened pre-filled from
      // a picker, where most fields are never touched.
      const sets = [];
      const params = [];
      for (const column of DIE_MAKER_COLUMNS) {
        const field = FIELD_FOR_COLUMN[column];
        if (!(field in body)) continue;
        const value = String(body[field] || '').trim();
        if (column === 'name' && !value) {
          return { ok: false, status: 400, error: 'A die maker needs a name.' };
        }
        sets.push(`${column} = ?`);
        params.push(value);
      }

      if ('isArchived' in body) {
        sets.push('is_archived = ?');
        params.push(body.isArchived ? 1 : 0);
      }

      if (sets.length) {
        sets.push('updated_at = ?');
        params.push(new Date().toISOString(), id);
        await run(`UPDATE die_makers SET ${sets.join(', ')} WHERE id = ?`, params);
      }

      const row = await get(`${LIST_SQL} WHERE m.id = ?`, [id]);
      // Before AND after for Track, both read the same way — the list query
      // adds usage_count, which the before-row lacks, so every save logged a
      // "Usage count '' → '0'" nobody made.
      const after = await get('SELECT * FROM die_makers WHERE id = ?', [id]);
      return { ok: true, dieMaker: rowToDto(row), before: existing, after };
    } catch (error) {
      if (isUniqueClash(error)) return duplicate('Another die maker already has that name.');
      throw error;
    }
  }

  /// Archive, or really delete when no die names it.
  ///
  /// A maker on a die is never removed outright: the die would be left pointing
  /// at nothing while still showing a name it no longer owns. Archiving keeps
  /// the row resolvable and takes it out of the picker, which is the whole of
  /// what "delete" means to the person asking.
  async function remove(id) {
    const row = await get(`${LIST_SQL} WHERE m.id = ?`, [id]);
    if (!row) return NOT_FOUND;

    if (Number(row.usage_count || 0) > 0) {
      await run(
        'UPDATE die_makers SET is_archived = 1, updated_at = ? WHERE id = ?',
        [new Date().toISOString(), id],
      );
      const archived = await get(`${LIST_SQL} WHERE m.id = ?`, [id]);
      return {
        ok: true,
        archived: true,
        dieMaker: rowToDto(archived),
        message: `${row.name} is on ${row.usage_count} die(s), so it was archived rather than deleted.`,
        before: row,
        after: archived,
      };
    }

    await run('DELETE FROM die_makers WHERE id = ?', [id]);
    return { ok: true, archived: false, before: row };
  }

  return { list, getOne, create, update, remove };
}

const { httpKit } = require('../../kernel/desk-kit');

module.exports = function registerDieMakerRoutes(ctx) {
  const { app, desk, requirePermission, trackCreate, trackUpdate, trackDelete } = ctx;
  const { ask, refuse } = httpKit(desk);

  app.get('/api/die-makers', requirePermission('dies.read'), async (req, res) => {
    try {
      const result = await ask(req, 'dies.makers.list', {
        includeArchived: String(req.query.includeArchived || '') === 'true',
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, dieMakers: result.dieMakers });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/die-makers/:id', requirePermission('dies.read'), async (req, res) => {
    try {
      const result = await ask(req, 'dies.makers.get', { id: Number(req.params.id) });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, dieMaker: result.dieMaker });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/die-makers', requirePermission('dies.create'), async (req, res) => {
    try {
      const result = await ask(req, 'dies.makers.create', { ...(req.body || {}) });
      if (!result.ok) return refuse(res, result);
      if (trackCreate) trackCreate('die_makers', result.id, result.row, req);
      res.json({ success: true, dieMaker: result.dieMaker });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/die-makers/:id', requirePermission('dies.update'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'dies.makers.update', { id, data: req.body || {} });
      if (!result.ok) return refuse(res, result);
      if (trackUpdate) trackUpdate('die_makers', id, result.before, result.after, req);
      res.json({ success: true, dieMaker: result.dieMaker });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/die-makers/:id', requirePermission('dies.delete'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'dies.makers.delete', { id });
      if (!result.ok) return refuse(res, result);
      if (result.archived) {
        if (trackUpdate) trackUpdate('die_makers', id, result.before, result.after, req);
        return res.json({
          success: true,
          archived: true,
          dieMaker: result.dieMaker,
          message: result.message,
        });
      }
      if (trackDelete) trackDelete('die_makers', id, result.before, req);
      res.json({ success: true, archived: false });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};

module.exports.createDieMakerService = createDieMakerService;
module.exports.rowToDto = rowToDto;
module.exports.gstComplaint = gstComplaint;
