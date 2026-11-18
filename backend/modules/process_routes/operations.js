'use strict';

// ---------------------------------------------------------------------------
// Process routing module — what it offers at the kernel desk.
//
// This file is the module at FUNCTION level: everything it can do, callable
// by name from its own HTTP routes or by another module, with no request
// object in sight. Whatever a route handler used to do that any other caller
// also needs — checking the part exists, defaulting the status, trimming the
// note — lives here, so two callers cannot disagree.
//
// Input contracts are deliberately loose where the service already reads what
// it is given (a step list in three spellings, a stage id as text): the
// service's own refusals are more specific than a type error, and tightening
// here would change answers the app already depends on.
// ---------------------------------------------------------------------------

module.exports = function processRouteOperations({ service }) {
  /// The part must exist before it can be routed. Checked explicitly so the
  /// answer is about the part rather than a foreign-key error about a table
  /// the caller has never heard of.
  async function withPart(input, then) {
    const id = Number(input.partId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, status: 400, error: 'Invalid part id.' };
    }
    if (!(await service.partExists(id))) {
      return { ok: false, status: 404, error: 'That part no longer exists.' };
    }
    return then(id);
  }

  /// A signed-in caller is the author; a module or the system names one, or
  /// leaves it empty.
  function authorOf(input, ctx) {
    if (ctx.actor?.kind === 'user') return ctx.actor.user?.id || null;
    const id = Number(input.userId);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /// What a saved route is called in Track, and the part's routes as they now
  /// stand — both callers of a save want them, so they travel with the result.
  async function withRoutes(partId, result) {
    if (!result.ok) return result;
    return {
      ...result,
      routes: await service.routesFor(partId),
      pipelineName: await service.pipelineNameFor(partId),
    };
  }

  const partId = { type: 'any', required: true };
  const steps = { type: 'any' };
  const note = { type: 'any' };
  const userId = { type: 'any' };

  return {
    'process_routes.stages.list': {
      permission: 'items.read',
      summary: 'The factory’s stage master, in order.',
      input: { fields: { includeInactive: { type: 'boolean' } } },
      run: async (input) => ({
        ok: true,
        stages: await service.listStages({
          includeInactive: input.includeInactive === true || input.includeInactive === 'true',
        }),
      }),
    },

    'process_routes.stages.create': {
      permission: 'items.create',
      summary: 'Add a stage by name. A name already in the master answers with that stage.',
      input: { fields: { name: { type: 'any' } } },
      run: (input) => service.createStage({ name: input.name }),
    },

    'process_routes.stages.retire': {
      permission: 'items.delete',
      summary: 'Retire a stage no draft or active route stands on.',
      input: { fields: { id: { type: 'any', required: true } } },
      run: (input) => service.retireStage(input.id),
    },

    'process_routes.routes.list': {
      permission: 'items.read',
      summary: 'Every version of a part’s route, active first.',
      input: { fields: { partId } },
      run: (input) =>
        withPart(input, async (id) => ({ ok: true, routes: await service.routesFor(id) })),
    },

    'process_routes.routes.save': {
      permission: 'items.update',
      summary: 'Save a part’s route as a draft or as the active one.',
      input: { fields: { partId, steps, status: { type: 'any' }, note, userId } },
      run: (input, ctx) =>
        withPart(input, async (id) =>
          withRoutes(
            id,
            await service.saveRoute(id, input.steps, {
              status: String(input.status || 'active'),
              note: String(input.note || '').trim(),
              userId: authorOf(input, ctx),
            }),
          ),
        ),
    },

    'process_routes.routes.version': {
      permission: 'items.update',
      summary: 'Declare a new version of the active route; the old one is retired.',
      input: { fields: { partId, steps, note, userId } },
      run: (input, ctx) =>
        withPart(input, async (id) =>
          withRoutes(
            id,
            await service.declareVersion(id, input.steps, {
              note: String(input.note || '').trim(),
              userId: authorOf(input, ctx),
            }),
          ),
        ),
    },
  };
};
