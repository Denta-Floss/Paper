'use strict';

// ---------------------------------------------------------------------------
// The units master: units, unit families, and the conversion graph.
//
// This lived in server.js (getUnitsWithUsage, saveUnit, saveUnitGroup,
// buildUnitGraph, convertValue, parseQualifiedValue, ensureKgUnit and the DTOs).
// It is here whole, with one deliberate change:
//
// HOW MUCH A UNIT IS USED was a subquery over four other modules' tables
// (materials; groups, items and item_unit_conversions; order_items and
// order_material_requirements). Units does not own those. It now asks each
// owner at the kernel desk for its count and adds its own (units that convert
// through this one). The number is the same; what changed is that units no
// longer names a table it does not own.
//
// The standard families and ladders, and the integer quantity engine, are in
// service.js. This file is the master data and the older factor-based
// conversion the app's unit converter calls.
// ---------------------------------------------------------------------------

function rowToUnitDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name || '',
    symbol: row.symbol || '',
    notes: row.notes || '',
    unitGroupId: row.unit_group_id || null,
    unitGroupName: row.unit_group_name || null,
    unitGroupDimension: row.unit_group_dimension || null,
    unitGroupBaseUnitId: row.unit_group_base_unit_id || null,
    factorToBase: Number(row.factor_to_base || 1),
    isBase: Boolean(row.is_base),
    onLadder: row.on_ladder == null ? true : Boolean(row.on_ladder),
    uqc: row.uqc || null,
    unitGroupCode: row.unit_group_code || null,
    unitGroupIntegralOnly: Boolean(row.unit_group_integral_only),
    conversionFactor: Number(row.conversion_factor || 1),
    conversionBaseUnitId: row.conversion_base_unit_id || null,
    conversionBaseUnitName: row.conversion_base_unit_name || null,
    conversionType: row.conversion_type || 'linear',
    precision: row.precision != null ? Number(row.precision) : null,
    isArchived: Boolean(row.is_archived),
    usageCount: row.usage_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToUnitGroupDto(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name || '',
    code: row.code || null,
    dimension: row.dimension || null,
    integralOnly: Boolean(row.integral_only),
    baseUnitId: row.base_unit_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUnitValue(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Who else counts a unit as in use. Each answers { counts: { unitId: n } }.
const USAGE_OPERATIONS = [
  'inventory.units.usageCounts',
  'items.units.usageCounts',
  'orders.units.usageCounts',
];

const UNIT_ROW_SELECT = `
    SELECT
      units.*,
      unit_groups.name AS unit_group_name,
      unit_groups.dimension AS unit_group_dimension,
      unit_groups.base_unit_id AS unit_group_base_unit_id,
      base_unit.name AS conversion_base_unit_name
    FROM units
    LEFT JOIN unit_groups ON unit_groups.id = units.unit_group_id
    LEFT JOIN units AS base_unit ON base_unit.id = units.conversion_base_unit_id`;

function createUnitsMaster({ get, all, run, desk }) {
  /// A function from unit id to how many records use it: the neighbours'
  /// counts plus the units that convert through it. With `unitId`, only that
  /// unit is counted.
  async function usageCounter(unitId = null) {
    const totals = new Map();
    const add = (id, count) => {
      const key = Number(id);
      totals.set(key, (totals.get(key) || 0) + Number(count || 0));
    };
    for (const operation of USAGE_OPERATIONS) {
      const { counts } = await desk.ask(operation, unitId == null ? {} : { unitId });
      for (const [id, count] of Object.entries(counts)) add(id, count);
    }
    const dependents = await all(
      `SELECT conversion_base_unit_id AS unit_id, COUNT(*) AS c
         FROM units
        WHERE conversion_base_unit_id IS NOT NULL
          ${unitId == null ? '' : 'AND conversion_base_unit_id = ?'}
        GROUP BY conversion_base_unit_id`,
      unitId == null ? [] : [unitId],
    );
    for (const row of dependents) add(row.unit_id, row.c);
    return (id) => totals.get(Number(id)) || 0;
  }

  async function getUnitRowById(id) {
    const row = await get(`${UNIT_ROW_SELECT}\n    WHERE units.id = ?`, [id]);
    if (!row) return row;
    return { ...row, usage_count: (await usageCounter(row.id))(row.id) };
  }

  async function getUnitsWithUsage() {
    const rows = await all(`${UNIT_ROW_SELECT}
    ORDER BY units.is_archived ASC, LOWER(COALESCE(unit_groups.name, '')) ASC, LOWER(units.name) ASC, LOWER(units.symbol) ASC`);
    const usage = await usageCounter();
    return rows.map((row) => ({ ...row, usage_count: usage(row.id) }));
  }

  async function findUnitDuplicate({ name, symbol, excludeId = null }) {
    const rows = await all('SELECT id, name, symbol FROM units');
    const normalizedName = normalizeUnitValue(name);
    const normalizedSymbol = normalizeUnitValue(symbol);
    return rows.find((row) => {
      if (excludeId != null && row.id === excludeId) {
        return false;
      }
      return (
        normalizeUnitValue(row.name) === normalizedName &&
        normalizeUnitValue(row.symbol) === normalizedSymbol
      );
    }) || null;
  }

  async function resolveUnitConversion({ unitGroupId, conversionFactor, excludeId = null }) {
    if (!unitGroupId) {
      return { conversionFactor: 1, conversionBaseUnitId: null };
    }
    const rows = await all(
      `
      SELECT * FROM units
      WHERE unit_group_id = ?
      ${excludeId != null ? 'AND id != ?' : ''}
      ORDER BY conversion_base_unit_id ASC, id ASC
      `,
      excludeId != null ? [unitGroupId, excludeId] : [unitGroupId],
    );
    const baseUnit = rows.find((row) => row.conversion_base_unit_id == null) || null;
    if (!baseUnit) {
      return { conversionFactor: 1, conversionBaseUnitId: null };
    }
    const normalizedFactor = Number(conversionFactor);
    if (!normalizedFactor || normalizedFactor <= 0) {
      const error = new Error('conversionFactor must be greater than 0 for grouped units.');
      error.statusCode = 400;
      throw error;
    }
    return {
      conversionFactor: normalizedFactor,
      conversionBaseUnitId: baseUnit.id,
    };
  }

  async function saveUnit({
    name,
    symbol,
    notes = '',
    unitGroupName = '',
    conversionFactor = 1,
    conversionType = 'linear',
    precision = null,
    id = null,
  }) {
    const trimmedName = String(name || '').trim();
    const trimmedSymbol = String(symbol || '').trim();
    const trimmedNotes = String(notes || '').trim();
    const resolvedUnitGroupId = await resolveUnitGroupId(unitGroupName);
    const resolvedConversion = await resolveUnitConversion({
      unitGroupId: resolvedUnitGroupId,
      conversionFactor,
      excludeId: id,
    });
    if (!trimmedName || !trimmedSymbol) {
      throw new Error('name and symbol are required.');
    }

    const duplicate = await findUnitDuplicate({
      name: trimmedName,
      symbol: trimmedSymbol,
      excludeId: id,
    });
    if (duplicate) {
      const error = new Error('A unit with the same name and symbol already exists.');
      error.statusCode = 409;
      throw error;
    }

    const now = new Date().toISOString();
    if (id == null) {
      const result = await run(
        `
        INSERT INTO units (name, symbol, unit_group_id, conversion_factor, conversion_base_unit_id, conversion_type, precision, notes, is_archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
        [
          trimmedName,
          trimmedSymbol,
          resolvedUnitGroupId,
          resolvedConversion.conversionFactor,
          resolvedConversion.conversionBaseUnitId,
          conversionType,
          precision,
          trimmedNotes,
          now,
          now,
        ],
      );
      return getUnitRowById(result.lastID);
    }

    const existing = await getUnitRowById(id);
    if (!existing) {
      const error = new Error('Unit not found.');
      error.statusCode = 404;
      throw error;
    }
    if ((existing.usage_count || 0) > 0) {
      const detailsChanged =
        normalizeUnitValue(existing.name) !== normalizeUnitValue(trimmedName) ||
        normalizeUnitValue(existing.symbol) !== normalizeUnitValue(trimmedSymbol) ||
        (existing.unit_group_id || null) !== (resolvedUnitGroupId || null) ||
        Number(existing.conversion_factor || 1) !== Number(resolvedConversion.conversionFactor || 1) ||
        (existing.conversion_base_unit_id || null) !== (resolvedConversion.conversionBaseUnitId || null) ||
        (existing.conversion_type || 'linear') !== conversionType;
      if (detailsChanged) {
        const error = new Error('Used units cannot change identity or conversion details.');
        error.statusCode = 409;
        throw error;
      }
    }

    await run(
      'UPDATE units SET name = ?, symbol = ?, unit_group_id = ?, conversion_factor = ?, conversion_base_unit_id = ?, conversion_type = ?, precision = ?, notes = ?, updated_at = ? WHERE id = ?',
      [
        trimmedName,
        trimmedSymbol,
        resolvedUnitGroupId,
        resolvedConversion.conversionFactor,
        resolvedConversion.conversionBaseUnitId,
        conversionType,
        precision,
        trimmedNotes,
        now,
        id,
      ],
    );
    return getUnitRowById(id);
  }

  /// Archives a unit nothing uses. Answers a result: not found and in use are
  /// refusals, not errors.
  async function archiveUnit(id) {
    const unit = await get('SELECT * FROM units WHERE id = ?', [id]);
    if (!unit) {
      return { ok: false, status: 404, error: 'Not found' };
    }
    if ((await usageCounter(id))(id) > 0) {
      return { ok: false, status: 409, error: 'Unit is in use' };
    }
    await run('UPDATE units SET is_archived = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    return { ok: true };
  }

  /// The kilogram, made if the master has none. Reconciling a challan weighs
  /// what came back, and needs a unit to weigh it in.
  async function ensureKgUnit() {
    const existing = await get(
      `SELECT id FROM units WHERE lower(symbol) = 'kg' OR lower(name) IN ('kg', 'kilogram', 'kilograms') ORDER BY id LIMIT 1`,
    );
    if (existing) return existing.id;
    const now = new Date().toISOString();
    const res = await run(
      `INSERT INTO units (name, symbol, notes, is_archived, created_at, updated_at)
       VALUES ('Kilogram', 'kg', 'Reconciliation weight unit', 0, ?, ?)`,
      [now, now],
    );
    return res.lastID;
  }

  // --- families --------------------------------------------------------------

  function listUnitGroups() {
    return all('SELECT * FROM unit_groups');
  }

  async function getUnitGroupRowByName(name) {
    const normalized = normalizeUnitValue(name);
    if (!normalized) {
      return null;
    }
    const rows = await all('SELECT * FROM unit_groups');
    return rows.find((row) => normalizeUnitValue(row.name) === normalized) || null;
  }

  async function saveUnitGroup({ name, dimension = null, baseUnitId = null, id = null }) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('name is required');

    const existing = await getUnitGroupRowByName(trimmedName);
    if (existing && existing.id !== id) {
      const error = new Error('A unit family with this name already exists.');
      error.statusCode = 409;
      throw error;
    }

    const now = new Date().toISOString();
    if (id == null) {
      const result = await run(
        'INSERT INTO unit_groups (name, dimension, base_unit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [trimmedName, dimension, baseUnitId, now, now]
      );
      const rows = await all('SELECT * FROM unit_groups WHERE id = ?', [result.lastID]);
      return rows[0];
    }
    await run(
      'UPDATE unit_groups SET name = ?, dimension = ?, base_unit_id = ?, updated_at = ? WHERE id = ?',
      [trimmedName, dimension, baseUnitId, now, id]
    );
    const rows = await all('SELECT * FROM unit_groups WHERE id = ?', [id]);
    return rows[0];
  }

  async function resolveUnitGroupId(unitGroupName) {
    const trimmed = String(unitGroupName || '').trim();
    if (!trimmed) {
      return null;
    }
    const existing = await getUnitGroupRowByName(trimmed);
    if (existing) {
      return existing.id;
    }
    const group = await saveUnitGroup({ name: trimmed });
    return group.id;
  }

  async function deleteUnitGroup(id) {
    await run('DELETE FROM unit_groups WHERE id = ?', [id]);
  }

  /// Every family with its unarchived units, smallest first.
  async function familiesWithUnits() {
    const groups = await all('SELECT * FROM unit_groups ORDER BY id ASC');
    const units = await all(
      'SELECT * FROM units WHERE is_archived = 0 ORDER BY unit_group_id ASC, factor_to_base ASC',
    );
    const byGroup = {};
    for (const u of units) {
      if (!u.unit_group_id) continue;
      if (!byGroup[u.unit_group_id]) byGroup[u.unit_group_id] = [];
      byGroup[u.unit_group_id].push(u);
    }
    return groups.map((g) => ({ ...g, units: byGroup[g.id] || [] }));
  }

  function gaugeTable() {
    return all('SELECT * FROM unit_conversion_points');
  }

  // --- the conversion graph --------------------------------------------------
  //
  // Built from the tables each time a batch is converted (three small reads).
  // It used to be rebuilt, without waiting, only after a unit or family was
  // saved through this file, and never at start-up: after a restart every
  // conversion answered "Unit not found" until somebody saved a unit, and a
  // unit added any other way (a seed, the kilogram made for a reconcile) was
  // never seen at all.

  let unitGraphCache = {
    unitsBySymbol: {},
    unitsById: {},
    families: {},
    gaugePoints: {},
  };

  async function buildUnitGraph() {
    const units = await all('SELECT * FROM units');
    const unitGroups = await all('SELECT * FROM unit_groups');
    const points = await all('SELECT * FROM unit_conversion_points');

    const cache = {
      unitsBySymbol: {},
      unitsById: {},
      families: {},
      gaugePoints: {}
    };

    for (const group of unitGroups) {
      if (group.base_unit_id) {
        cache.families[group.base_unit_id] = { id: group.id, name: group.name, dimension: group.dimension, baseUnitId: group.base_unit_id, members: [] };
      }
    }

    for (const u of units) {
      const dto = rowToUnitDto(u);
      cache.unitsById[u.id] = dto;
      if (u.symbol) cache.unitsBySymbol[u.symbol.toLowerCase()] = dto;
      if (u.conversion_base_unit_id && cache.families[u.conversion_base_unit_id]) {
        cache.families[u.conversion_base_unit_id].members.push(dto);
      }
    }

    for (const pt of points) {
      if (!cache.gaugePoints[pt.unit_id]) cache.gaugePoints[pt.unit_id] = [];
      cache.gaugePoints[pt.unit_id].push({ key: pt.point_key, baseValue: pt.base_value });
    }

    unitGraphCache = cache;
  }

  function parseQualifiedValue(valueStr, unitGraph = unitGraphCache) {
    if (!Number.isNaN(Number(valueStr))) {
      return { value: Number(valueStr), unit: null, isGauge: false };
    }
    const str = String(valueStr).trim();
    const match = str.match(/^([0-9/.]+)([a-zA-Z]+)$/);
    if (match) {
      const rawVal = match[1];
      const symbol = match[2].toLowerCase();
      const unit = unitGraph.unitsBySymbol[symbol];
      if (unit) {
        if (unit.conversionType === 'table') {
          return { value: rawVal, unit, isGauge: true };
        }
        return { value: Number(rawVal), unit, isGauge: false };
      }
    }
    return { value: valueStr, unit: null, isGauge: false };
  }

  function convertValue(value, fromUnitId, toUnitId, unitGraph = unitGraphCache) {
    if (fromUnitId === toUnitId) return value;

    const from = unitGraph.unitsById[fromUnitId];
    const to = unitGraph.unitsById[toUnitId];

    if (!from || !to) throw new Error(`Unit not found: ${fromUnitId} -> ${toUnitId}`);

    const base1 = from.conversionBaseUnitId || from.id;
    const base2 = to.conversionBaseUnitId || to.id;

    if (base1 !== base2) {
      const err = new Error(`Cannot convert across different unit families (${from.symbol} and ${to.symbol})`);
      err.statusCode = 400;
      throw err;
    }

    let baseValue;
    if (from.conversionType === 'table') {
      const points = unitGraph.gaugePoints[from.id] || [];
      const pt = points.find(p => String(p.key).toLowerCase() === String(value).toLowerCase());
      if (!pt) {
        const err = new Error(`Unknown table value ${value} for unit ${from.symbol}`);
        err.statusCode = 400;
        throw err;
      }
      baseValue = pt.baseValue;
    } else {
      baseValue = Number(value) * from.conversionFactor;
    }

    let result;
    if (to.conversionType === 'table') {
      const points = unitGraph.gaugePoints[to.id] || [];
      let closest = null;
      let minDiff = Infinity;
      for (const p of points) {
        const diff = Math.abs(p.baseValue - baseValue);
        if (diff < minDiff) {
          minDiff = diff;
          closest = p;
        }
      }
      if (!closest || minDiff > 0.0001) {
        const err = new Error(`Cannot convert precisely to table unit ${to.symbol} from ${baseValue}`);
        err.statusCode = 400;
        throw err;
      }
      result = closest.key;
    } else {
      result = baseValue / to.conversionFactor;
    }

    return result;
  }

  /// Converts a batch against the units as they are now.
  async function convertBatch(conversions = []) {
    await buildUnitGraph();
    return conversions.map(convertOne);
  }

  /// One conversion of a batch: a value (a number, or text like "22G") from one
  /// unit to another. A failure is this line's answer, not the batch's.
  function convertOne(conv) {
    try {
      let fromUnitId = conv.fromUnitId;
      const toUnitId = conv.toUnitId;

      let value = conv.value;
      if (typeof value === 'string') {
        const parsed = parseQualifiedValue(value);
        value = parsed.value;
        if (!fromUnitId && parsed.unit) {
          fromUnitId = parsed.unit.id;
        }
      }

      const converted = convertValue(value, fromUnitId, toUnitId);
      return { success: true, value: converted };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return {
    getUnitRowById,
    getUnitsWithUsage,
    findUnitDuplicate,
    resolveUnitConversion,
    saveUnit,
    archiveUnit,
    ensureKgUnit,
    listUnitGroups,
    getUnitGroupRowByName,
    saveUnitGroup,
    resolveUnitGroupId,
    deleteUnitGroup,
    familiesWithUnits,
    gaugeTable,
    buildUnitGraph,
    parseQualifiedValue,
    convertValue,
    convertBatch,
    rawUnit: (id) => get('SELECT * FROM units WHERE id = ?', [id]),
  };
}

module.exports = {
  createUnitsMaster,
  rowToUnitDto,
  rowToUnitGroupDto,
  normalizeUnitValue,
  USAGE_OPERATIONS,
};
