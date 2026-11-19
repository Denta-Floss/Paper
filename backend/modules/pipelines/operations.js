'use strict';

const F = require('../../kernel/fields');

// ---------------------------------------------------------------------------
// Pipeline templates — what the module offers at the kernel desk.
//
//   offered to users
//     pipelines.templates.list · .save · .update · .delete
//
//   internal — asked by other modules
//     pipelines.templates.row      a template as stored, for production
//
// These are the app's own set, /api/production/pipeline-templates. A template's
// body is free-form (a node graph), so it travels whole under `data`.
//
//     pipelines.legacyTemplates.list · .get · .create · .update · .delete
//
// The older /templates set, outside /api. It was never behind a pipelines
// permission: its guards (server.js, app.use('/templates', …)) let any
// signed-in user read and ask for `config.write` to change anything. These
// operations ask exactly that, so nobody is answered differently. Unlike the
// app's set, a delete here does not check for runs, and a change bumps the
// version; both are as they were.
//
// Production is asked at the desk how many runs were started from a template.
// ---------------------------------------------------------------------------

const { fromRefusal } = require('../../kernel/desk-kit');

const object = { type: 'object' };
const templateResult = { fields: { template: { ...object, required: true } } };

module.exports = function pipelineOperations({ service, desk }) {
  return {
    'pipelines.templates.list': {
      permission: 'pipelines.read',
      summary: 'Every template, or one factory’s plus the shared ones.',
      input: { fields: { factoryId: F.text } },
      output: { fields: { templates: { type: 'array', required: true, items: object } } },
      run: async (input) => ({ ok: true, templates: await service.apiListTemplates(input.factoryId) }),
    },

    'pipelines.templates.save': {
      permission: 'pipelines.create',
      summary: 'Save a template; one with the same id is replaced.',
      input: { fields: { data: F.obj({ id: F.text, name: F.text, description: F.text, status: F.text, factoryId: F.text, factory_id: F.text, shopFloorId: F.text, shop_floor_id: F.text, nodes: F.list(), flows: F.list(), laneLabels: F.list(), stageLabels: F.list(), intermediateNamingConvention: F.text, intermediate_naming_convention: F.text }) } },
      output: templateResult,
      run: async (input) => {
        const row = await service.apiSaveTemplate(input.data);
        return { ok: true, template: service.rowToTemplate(row), row };
      },
    },

    'pipelines.templates.update': {
      permission: 'pipelines.update',
      summary: 'Change a template; what is left out is kept.',
      input: { fields: { id: F.key, data: F.obj({ id: F.text, name: F.text, description: F.text, status: F.text, factoryId: F.text, factory_id: F.text, shopFloorId: F.text, shop_floor_id: F.text, nodes: F.list(), flows: F.list(), laneLabels: F.list(), stageLabels: F.list(), intermediateNamingConvention: F.text, intermediate_naming_convention: F.text }) } },
      output: templateResult,
      run: async (input) => {
        const saved = await service.apiUpdateTemplate(input.id, input.data);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return {
          ok: true,
          template: service.rowToTemplate(saved.row),
          before: saved.existing,
          row: saved.row,
        };
      },
    },

    'pipelines.legacyTemplates.list': {
      access: 'signedIn',
      summary: 'Every template (the older /templates set).',
      output: { fields: { templates: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, templates: await service.rootListTemplates() }),
    },

    'pipelines.legacyTemplates.get': {
      access: 'signedIn',
      summary: 'One template (the older /templates set).',
      input: { fields: { id: F.key } },
      output: templateResult,
      run: async (input) => {
        const row = await service.getTemplateRow(input.id);
        if (!row) return { ok: false, status: 404, template: null, error: 'Template not found.' };
        return { ok: true, template: service.rowToTemplate(row) };
      },
    },

    'pipelines.legacyTemplates.create': {
      permission: 'config.write',
      summary: 'Create a template; id and name are required (the older /templates set).',
      input: { fields: { data: { type: 'object' } } },
      output: templateResult,
      run: async (input) => {
        const made = await service.rootCreateTemplate(input.data || {});
        if (made.refusal) return fromRefusal(made.refusal);
        return { ok: true, template: service.rowToTemplate(made.row) };
      },
    },

    'pipelines.legacyTemplates.update': {
      permission: 'config.write',
      summary: 'Change a template and bump its version (the older /templates set).',
      input: { fields: { id: F.key, data: F.obj({ id: F.text, name: F.text, description: F.text, status: F.text, factoryId: F.text, factory_id: F.text, shopFloorId: F.text, shop_floor_id: F.text, nodes: F.list(), flows: F.list(), laneLabels: F.list(), stageLabels: F.list(), intermediateNamingConvention: F.text, intermediate_naming_convention: F.text }) } },
      output: templateResult,
      run: async (input) => {
        const saved = await service.rootUpdateTemplate(input.id, input.data || {});
        if (saved.refusal) return fromRefusal(saved.refusal);
        return { ok: true, template: service.rowToTemplate(saved.row) };
      },
    },

    'pipelines.legacyTemplates.delete': {
      permission: 'config.write',
      summary: 'Remove a template without checking for runs (the older /templates set).',
      input: { fields: { id: F.key } },
      run: async (input) => {
        if (!(await service.getTemplateRow(input.id))) {
          return { ok: false, status: 404, error: 'Template not found.' };
        }
        await service.deleteTemplateRow(input.id);
        return { ok: true };
      },
    },

    'pipelines.templates.row': {
      internal: true,
      summary: 'A template’s row as stored, or nothing. Production reads the nodes a run was started from.',
      input: { fields: { id: F.key } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getTemplateRow(input.id) }),
    },

    'pipelines.templates.delete': {
      permission: 'pipelines.delete',
      summary: 'Remove a template no run was ever started from.',
      input: { fields: { id: F.key } },
      run: async (input) => {
        if ((await desk.ask('production.templates.runCount', { templateId: input.id })).count > 0) {
          return {
            ok: false,
            status: 400,
            error: 'Cannot delete pipeline template: there are ongoing or historical runs using it.',
          };
        }
        return { ok: true, before: await service.deleteTemplateRow(input.id) };
      },
    },
  };
};
