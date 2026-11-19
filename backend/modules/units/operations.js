'use strict';

// ---------------------------------------------------------------------------
// Units — what the module offers at the kernel desk.
//
//   offered to users
//     units.list · units.create · units.update · units.archive · units.delete
//     units.families.list · .withUnits · .create · .update · .delete
//     units.gaugeTable · units.convertBatch · units.seedStandard
//
//   internal — asked by other modules
//     units.rows.get           a unit's row, for inventory
//     units.ensureKilogram     the kilogram, made if missing, for challans
//
// Every operation declares what it takes and what an ok result carries, and
// the server holds them to it. A contract here says what a field IS (text, a
// number, an id) and that a unit and a family need a name; it does not repeat
// the master's own rules, which answer in their own words.
//
// A write's result also carries the raw rows the Track entry is written from
// (`row`, `before`, `after`). Track needs the request for its actor and sitting,
// so the route writes it; these travel with the result so the route does not
// have to read the database to do so.
// ---------------------------------------------------------------------------

const { seedStandardUnitFamilies, STANDARD_FAMILIES } = require('./service');
const { rowToUnitDto, rowToUnitGroupDto } = require('./master');
const { refusing } = require('../../kernel/desk-kit');

const id = { type: 'integer', required: true, gt: 0 };
const text = { type: 'string' };
const object = { type: 'object' };

const unitFields = {
  name: { type: 'string', required: true, nonEmpty: true },
  symbol: { type: 'string', required: true, nonEmpty: true },
  notes: { ...text, nullable: true },
  unitGroupName: { ...text, nullable: true },
  // A number, and no more than that here: whether it has to be above zero
  // depends on whether the unit is in a family, which the master decides.
  conversionFactor: { type: 'number', nullable: true },
  conversionType: { type: 'string', nullable: true },
  precision: { type: 'integer', min: 0, nullable: true },
};
const familyFields = {
  name: { type: 'string', required: true, nonEmpty: true },
  dimension: { ...text, nullable: true },
  baseUnitId: { type: 'integer', nullable: true },
};

const unitResult = { fields: { unit: { ...object, required: true } } };
const familyResult = { fields: { unitGroup: { ...object, required: true } } };

module.exports = function unitOperations({ master, db, trashAndDelete }) {
  return {
    // --- offered to users --------------------------------------------------

    'units.list': {
      permission: 'units.read',
      summary: 'Every unit, with its family and how many records use it.',
      output: { fields: { units: { type: 'array', required: true, items: object } } },
      run: async () => ({
        ok: true,
        units: (await master.getUnitsWithUsage()).map(rowToUnitDto),
      }),
    },

    'units.create': {
      permission: 'units.create',
      summary: 'Add a unit. A named family that does not exist is made.',
      input: { fields: unitFields },
      output: { fields: { unit: { ...object, required: true }, row: { ...object, required: true } } },
      run: (input) =>
        refusing(async () => {
          const row = await master.saveUnit({ ...input, id: null });
          return { ok: true, unit: rowToUnitDto(row), row };
        }),
    },

    'units.update': {
      permission: 'units.update',
      summary: 'Change a unit. A unit in use keeps its identity and conversion.',
      input: { fields: { id, ...unitFields } },
      output: unitResult,
      run: (input) =>
        refusing(async () => {
          const unitId = Number(input.id);
          const before = await master.rawUnit(unitId);
          const row = await master.saveUnit({ ...input, id: unitId });
          return { ok: true, unit: rowToUnitDto(row), before, after: await master.rawUnit(unitId) };
        }),
    },

    'units.archive': {
      permission: 'units.update',
      summary: 'Archive a unit nothing uses.',
      input: { fields: { id } },
      run: (input) => master.archiveUnit(Number(input.id)),
    },

    'units.delete': {
      permission: 'units.delete',
      summary: 'Move a unit to the trash.',
      input: { fields: { id } },
      run: async (input, ctx) => {
        const unitId = Number(input.id);
        const before = await master.rawUnit(unitId);
        // The trash is the action center's, and is still handed in by name. It
        // reads only who is deleting.
        await trashAndDelete('units', unitId, { user: ctx.actor?.user || null });
        return { ok: true, before };
      },
    },

    'units.families.list': {
      permission: 'units.read',
      summary: 'The unit families.',
      output: { fields: { unitGroups: { type: 'array', required: true, items: object } } },
      run: async () => ({
        ok: true,
        unitGroups: (await master.listUnitGroups()).map(rowToUnitGroupDto),
      }),
    },

    'units.families.withUnits': {
      permission: 'units.read',
      summary: 'Every family with its unarchived units, smallest first.',
      output: { fields: { families: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, families: await master.familiesWithUnits() }),
    },

    'units.families.create': {
      permission: 'units.create',
      summary: 'Add a unit family.',
      input: { fields: familyFields },
      output: familyResult,
      run: (input) =>
        refusing(async () => ({
          ok: true,
          unitGroup: rowToUnitGroupDto(await master.saveUnitGroup({ ...input, id: null })),
        })),
    },

    'units.families.update': {
      permission: 'units.update',
      summary: 'Rename a unit family, or set its dimension and base unit.',
      input: { fields: { id, ...familyFields } },
      output: familyResult,
      run: (input) =>
        refusing(async () => ({
          ok: true,
          unitGroup: rowToUnitGroupDto(
            await master.saveUnitGroup({ ...input, id: Number(input.id) }),
          ),
        })),
    },

    'units.families.delete': {
      permission: 'units.delete',
      summary: 'Remove a unit family.',
      input: { fields: { id } },
      run: async (input) => {
        await master.deleteUnitGroup(Number(input.id));
        return { ok: true };
      },
    },

    'units.gaugeTable': {
      permission: 'units.read',
      summary: 'The points of every table-backed unit (wire gauges).',
      output: { fields: { points: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, points: await master.gaugeTable() }),
    },

    'units.convertBatch': {
      permission: 'units.read',
      summary: 'Convert values between units of one family. Each line answers for itself.',
      input: {
        fields: {
          conversions: {
            type: 'array',
            items: {
              type: 'object',
              // Each line answers for itself, bad value or unknown unit included,
              // so the fields are not typed here: a typed contract would refuse
              // the whole batch for one line.
              fields: { value: { type: 'any', required: true }, fromUnitId: { type: 'any' }, toUnitId: { type: 'any' } },
            },
          },
        },
      },
      output: { fields: { results: { type: 'array', required: true, items: object } } },
      run: async (input) => {
        const { conversions = [] } = input;
        return { ok: true, results: await master.convertBatch(conversions) };
      },
    },

    'units.seedStandard': {
      permission: 'units.create',
      summary: 'Make sure the standard families and their ladders exist.',
      output: { fields: { seededFamilies: { type: 'array', required: true, items: text } } },
      run: async () => {
        await seedStandardUnitFamilies(db);
        return { ok: true, seededFamilies: STANDARD_FAMILIES.map((family) => family.code) };
      },
    },

    // --- internal: asked by other modules ----------------------------------

    'units.rows.get': {
      internal: true,
      summary: 'A unit’s row with its family and usage count, or nothing.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async (input) => ({ ok: true, row: await master.getUnitRowById(input.id) }),
    },

    'units.rows.first': {
      internal: true,
      summary: 'The lowest-numbered unit, for a caller that needs some unit when none was chosen; or nothing.',
      input: { fields: {} },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async () => ({ ok: true, row: (await master.firstUnitRow()) || null }),
    },

    'units.ensureKilogram': {
      internal: true,
      // Called before the reconcile's transaction opens today; marked so it may
      // be called inside one.
      joinsCallerTransaction: true,
      summary: 'The kilogram’s id; the unit is made if the master has none.',
      output: { fields: { unitId: { type: 'integer', required: true, gt: 0 } } },
      run: async () => ({ ok: true, unitId: await master.ensureKgUnit() }),
    },
  };
};
