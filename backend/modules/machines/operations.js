'use strict';

// ---------------------------------------------------------------------------
// Machine — what the module offers at the kernel desk.
//
//   offered to users
//     machines.list · machines.get · machines.save · machines.delete
//
// `save` is the route's upsert: an `id` that is a real one updates, anything
// else creates. Its result carries the raw rows the Track entry is written
// from.
//
// Still reached by hand: production, asked whether a live run holds the
// machine (its port), and the kernel's link and variation purge, which mount
// after this module. Asset routes call the kernel's asset service directly.
// ---------------------------------------------------------------------------

const { fromRefusal } = require('../../kernel/desk-kit');

const object = { type: 'object' };
// Ids arrive as text and may be a temporary one ("temp_3") on a create.
const anyId = { type: 'any', required: true };

module.exports = function machineOperations({
  service,
  desk,
  getPurgeEntityLinks,
  getPurgeEntityVariations,
}) {
  return {
    'machines.list': {
      permission: 'machines.read',
      summary: 'Every machine, newest first.',
      output: { fields: { machines: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, machines: await service.listMachines() }),
    },

    'machines.get': {
      permission: 'machines.read',
      summary: 'One machine.',
      input: { fields: { id: anyId } },
      output: { fields: { machine: { ...object, required: true } } },
      run: async (input) => {
        const machine = await service.getMachine(input.id);
        if (!machine) return { ok: false, status: 404, machine: null, error: 'Machine not found' };
        return { ok: true, machine };
      },
    },

    'machines.save': {
      permission: 'machines.create',
      summary: 'Create a machine, or update the one whose id is given. What is left out is kept.',
      input: { fields: { id: { type: 'any' }, name: { type: 'string', nullable: true } } },
      output: { fields: { machine: { ...object, required: true } } },
      run: async (input) => {
        const saved = await service.saveMachine(input);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return {
          ok: true,
          machine: saved.machine,
          isUpdate: Boolean(saved.isUpdate),
          resultId: saved.resultId,
          before: saved.beforeRow,
          row: saved.row,
        };
      },
    },

    'machines.rows.get': {
      internal: true,
      summary: 'A machine’s row as stored, or nothing. Production reads it for a machine’s queue.',
      input: { fields: { id: anyId } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getMachineRow(input.id) }),
    },

    'machines.rows.byAssetOrName': {
      internal: true,
      summary: 'The machine a pipeline node names, by its machine number or its name; or nothing.',
      input: { fields: { key: { type: 'any', required: true } } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getMachineRowByAssetOrName(input.key) }),
    },

    'machines.rows.remove': {
      internal: true,
      summary: 'Delete a machine’s row outright: an approved delete request.',
      input: { fields: { id: { type: 'any', required: true } } },
      run: async (input) => {
        await service.removeMachineRow(input.id);
        return { ok: true };
      },
    },

    'machines.delete': {
      permission: 'machines.delete',
      summary: 'Remove a machine, unless a live run holds it. Its links and variation tree go with it.',
      input: { fields: { id: anyId } },
      run: async (input) => {
        const id = input.id;
        if ((await desk.ask('production.machines.assignedToActiveRun', { machineId: id })).assigned) {
          return {
            ok: false,
            status: 400,
            error: 'Cannot delete machine: assigned to an active pipeline run.',
          };
        }
        const before = await service.deleteMachine(id);
        const purgeEntityLinks = getPurgeEntityLinks();
        const purgeEntityVariations = getPurgeEntityVariations();
        if (purgeEntityLinks) await purgeEntityLinks('machine', id);
        if (purgeEntityVariations) await purgeEntityVariations('machine', id);
        return { ok: true, before };
      },
    },
  };
};
