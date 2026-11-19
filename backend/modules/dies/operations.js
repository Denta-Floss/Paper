'use strict';

const F = require('../../kernel/fields');

// ---------------------------------------------------------------------------
// Die — what the module offers at the kernel desk.
//
//   offered to users
//     dies.list · dies.get · dies.save · dies.delete
//     dies.makers.list · .get · .create · .update · .delete
//
// `save` is the route's upsert: an `id` that is a real one updates, anything
// else creates. Its result carries the raw rows the Track entry is written
// from.
//
// Still reached by hand: production, asked whether a live run holds the
// die (its port), and the kernel's link and variation purge, which mount
// after this module. Asset routes call the kernel's asset service directly.
//
// dies.makers.* is the die makers master ("Die Made By"), whose work is in
// ./die-makers.js. A maker a die names is archived by `delete`, never removed.
// ---------------------------------------------------------------------------

const { fromRefusal } = require('../../kernel/desk-kit');

const object = { type: 'object' };
// Ids arrive as text and may be a temporary one ("temp_3") on a create.
const anyId = F.id;

const makerId = { type: 'integer', required: true, gt: 0 };
const makerResult = { fields: { dieMaker: { ...object, required: true } } };
const optionalText = { type: 'string', nullable: true };
const makerFields = {
  alias: optionalText,
  gstNumber: optionalText,
  address: optionalText,
  contactName: optionalText,
  designation: optionalText,
  phone: optionalText,
  email: optionalText,
  logoUrl: optionalText,
  photoUrl: optionalText,
};

module.exports = function dieOperations({
  service,
  makers,
  desk,
  getPurgeEntityLinks,
  getPurgeEntityVariations,
}) {
  return {
    'dies.list': {
      permission: 'dies.read',
      summary: 'Every die, newest first.',
      output: { fields: { dies: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, dies: await service.listDies() }),
    },

    'dies.get': {
      permission: 'dies.read',
      summary: 'One die.',
      input: { fields: { id: anyId } },
      output: { fields: { die: { ...object, required: true } } },
      run: async (input) => {
        const die = await service.getDie(input.id);
        if (!die) return { ok: false, status: 404, die: null, error: 'Die not found' };
        return { ok: true, die };
      },
    },

    'dies.save': {
      permission: 'dies.create',
      summary: 'Create a die, or update the one whose id is given. What is left out is kept.',
      input: { fields: { id: { ...F.int, nullable: true }, name: { type: 'string', nullable: true } } },
      output: { fields: { die: { ...object, required: true } } },
      run: async (input) => {
        const saved = await service.saveDie(input);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return {
          ok: true,
          die: saved.die,
          isUpdate: Boolean(saved.isUpdate),
          resultId: saved.resultId,
          before: saved.beforeRow,
          row: saved.row,
        };
      },
    },

    'dies.rows.get': {
      internal: true,
      summary: 'A die’s row as stored, or nothing.',
      input: { fields: { id: F.id } },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getDieRow(input.id) }),
    },

    'dies.rows.all': {
      internal: true,
      summary: 'Every die as stored. For the order reports, which key dies by id and tool code.',
      input: { fields: {} },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async () => ({ ok: true, rows: await service.allDieRows() }),
    },

    'dies.rows.byToolCode': {
      internal: true,
      summary: 'The die a pipeline node names, by its tool code; or nothing.',
      input: { fields: { toolCode: F.key } },
      output: { fields: { row: { ...object, nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getDieRowByToolCode(input.toolCode) }),
    },

    'dies.makers.list': {
      permission: 'dies.read',
      summary: 'The die makers, archived last, each with how many dies name it.',
      input: { fields: { includeArchived: { type: 'boolean' } } },
      output: { fields: { dieMakers: { type: 'array', required: true, items: object } } },
      run: (input) => makers.list({ includeArchived: input.includeArchived === true }),
    },

    'dies.makers.get': {
      permission: 'dies.read',
      summary: 'One die maker.',
      input: { fields: { id: makerId } },
      output: makerResult,
      run: (input) => makers.getOne(input.id),
    },

    'dies.makers.create': {
      permission: 'dies.create',
      summary: 'Add a die maker. Only a name is needed; one per name.',
      // That a die maker needs a name is the service's to say, in its own words.
      input: { fields: { name: optionalText, ...makerFields } },
      output: makerResult,
      run: (input) => makers.create(input),
    },

    'dies.makers.update': {
      permission: 'dies.update',
      // Under `data` because absent and present-but-empty mean different
      // things here: a field left out is kept, a field sent empty is cleared.
      summary: 'Change a die maker. A field left out is kept; one sent empty is cleared.',
      input: {
        fields: {
          id: makerId,
          data: {
            type: 'object',
            required: true,
            fields: { name: optionalText, ...makerFields, isArchived: { type: 'boolean' } },
          },
        },
      },
      output: makerResult,
      run: (input) => makers.update(Number(input.id), input.data || {}),
    },

    'dies.makers.delete': {
      permission: 'dies.delete',
      summary: 'Remove a die maker no die names; archive one that a die does.',
      input: { fields: { id: makerId } },
      run: (input) => makers.remove(Number(input.id)),
    },

    'dies.rows.remove': {
      internal: true,
      summary: 'Delete a die’s row outright: an approved delete request.',
      input: { fields: { id: F.id } },
      run: async (input) => {
        await service.removeDieRow(input.id);
        return { ok: true };
      },
    },

    'dies.delete': {
      permission: 'dies.delete',
      summary: 'Remove a die, unless a live run holds it. Its links and variation tree go with it.',
      input: { fields: { id: anyId } },
      run: async (input) => {
        const id = input.id;
        if ((await desk.ask('production.dies.assignedToActiveRun', { dieId: id })).assigned) {
          return {
            ok: false,
            status: 400,
            error: 'Cannot delete die: assigned to an active pipeline run.',
          };
        }
        const before = await service.deleteDie(id);
        const purgeEntityLinks = getPurgeEntityLinks();
        const purgeEntityVariations = getPurgeEntityVariations();
        if (purgeEntityLinks) await purgeEntityLinks('die', id);
        if (purgeEntityVariations) await purgeEntityVariations('die', id);
        return { ok: true, before };
      },
    },
  };
};
