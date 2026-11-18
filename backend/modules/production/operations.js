'use strict';

// ---------------------------------------------------------------------------
// Production — what the module offers at the kernel desk.
//
//   offered to users
//     production.runs.list · .get · .start · .delete
//     production.runs.setNodeStatus · .setNodeMetrics · .setBatches
//     production.runs.assignStock · .changeStock · .removeStock
//     production.scrap.record · .list
//     production.output.completed
//     production.machines.queue · production.items.pipelineHistory
//
// WHO MAY ASK follows the guard each route always had, which is not one rule:
//   - the /runs set sits outside /api. Its guards (server.js) let any signed-in
//     user read and ask for `config.write` to change anything;
//   - /api/production-runs is gated as production, /api/machines/:id/queue as
//     machines and /api/items/:id/pipeline-history as items, because the gate
//     goes by the first path segment;
//   - /api/production-scrap maps to no module: reading needs a session, and
//     recording needs what the old write gate asks.
//
//   internal — asked by other modules (./ports.js behind a name)
//     production.runs.row · .stages · .inputs · .inputsForRuns · .stageTotals
//     production.runs.linksForOrderItem · .orderItemIds · .allWithOrderItem
//     production.runs.forOrderItems · .summariesForOrderItems
//     production.runs.inputCountForBarcode · .latestInputForBarcode
//     production.runs.dissolve · .unlinkOrderItem      (inside the caller's transaction)
//     production.output.source · production.challanLines.runInputs
//     production.machines.assignedToActiveRun · production.dies.assignedToActiveRun
//     production.templates.runCount
//
// One thing other modules still get that is not an operation:
// orderItemRunStatusSql (./ports.js), a piece of SQL the order list embeds so
// it can filter, count and page on a line's run status in one statement.
//
// The work is ./work.js. Each function there returns the status and body its
// handler used to send; `answered` below turns that into a result, keeping
// every field, so the route can send back exactly what it always did.
//
// A run's payloads (its nodes, overrides, a stage's numbers, batches) are
// free-form and travel whole under `data`.
// ---------------------------------------------------------------------------

/// An answer (status, body) as a desk result. `success` is dropped because it
/// is `ok`; it is kept only in the odd case where the two disagreed.
function answered({ status, body }) {
  const { success, ...rest } = body || {};
  if (status < 400) {
    return {
      ok: true,
      ...(status !== 200 ? { httpStatus: status } : {}),
      ...(success !== true ? { success } : {}),
      ...rest,
    };
  }
  return { ok: false, status, ...(success !== false ? { success } : {}), ...rest };
}

const any = { type: 'any' };
const runId = { type: 'any', required: true };
const data = { type: 'object', nullable: true };
const rows = (key) => ({ fields: { [key]: { type: 'array', required: true } } });
const runResult = { fields: { run: { type: 'object', required: true } } };

// What the old write gate asks of a POST to a path no module claims.
const OLD_WRITE_GATE = {
  anyRole: ['super_admin', 'admin'],
  anyPermission: ['config.write', 'inventory.update'],
};

const one = (name, type = 'any') => ({ fields: { [name]: { type, required: true } } });
const list = (name) => ({ fields: { [name]: { type: 'array', required: true } } });
// As an argument a list may be left out: the ports treat that as none.
const listArg = (name) => ({ fields: { [name]: { type: 'array', nullable: true } } });

/// What other modules ask of production. Each is a function in ./ports.js; the
/// name here is what a caller declares it uses.
function internalOperations(ports) {
  const read = (summary, input, key, ask, output) => ({
    internal: true,
    summary,
    input,
    output: output || { fields: { [key]: { type: 'any' } } },
    run: async (given) => ({ ok: true, [key]: await ask(given) }),
  });
  return {
    'production.runs.row': read(
      'A run’s row, or nothing.', one('runId'), 'row', (i) => ports.runs.rowById(i.runId)),
    'production.runs.stages': read(
      'A run’s stage reconciliation rows.', one('runId'), 'stages',
      (i) => ports.runs.stagesForRun(i.runId), list('stages')),
    'production.runs.inputs': read(
      'What was put on a run.', one('runId'), 'inputs',
      (i) => ports.runs.inputsForRun(i.runId), list('inputs')),
    'production.runs.inputsForRuns': read(
      'What these runs consumed, oldest first.', listArg('runIds'), 'inputs',
      (i) => ports.runs.inputsForRuns(i.runIds), list('inputs')),
    'production.runs.stageTotals': read(
      'Allotted, output, scrap and leftover summed over these runs’ stages.', listArg('runIds'),
      'totals', (i) => ports.runs.stageTotalsForRuns(i.runIds)),
    'production.runs.linksForOrderItem': read(
      'The links from one order line to its runs.', one('orderItemId'), 'links',
      (i) => ports.runs.linkedToOrderItem(i.orderItemId), list('links')),
    'production.runs.orderItemIds': read(
      'The order lines a run was started for, as rows of order_item_id.', one('runId'), 'rows',
      (i) => ports.runs.orderItemIdsForRun(i.runId), list('rows')),
    'production.runs.allWithOrderItem': read(
      'Every linked run, one row per link, with its order line.', { fields: {} }, 'runs',
      () => ports.runs.allWithOrderItem(), list('runs')),
    'production.runs.forOrderItems': read(
      'The runs of these order lines, newest first, one row per link.', listArg('orderItemIds'),
      'runs', (i) => ports.runs.forOrderItems(i.orderItemIds), list('runs')),
    'production.runs.summariesForOrderItems': read(
      'The runs of these order lines once each, with what a summary needs.',
      listArg('orderItemIds'), 'runs',
      (i) => ports.runs.summariesForOrderItems(i.orderItemIds), list('runs')),
    'production.runs.inputCountForBarcode': read(
      'How many times a barcode was put on a run.', one('barcode'), 'count',
      (i) => ports.runs.inputCountForBarcode(i.barcode),
      { fields: { count: { type: 'integer', required: true, min: 0 } } }),
    'production.runs.latestInputForBarcode': read(
      'The run and node a barcode was last put on, or nothing.', one('barcode'), 'input',
      (i) => ports.runs.latestInputForBarcode(i.barcode)),
    'production.output.source': read(
      'Where a finished lot came from: its run code and source details.', one('productionRunId'),
      'source', (i) => ports.output.sourceById(i.productionRunId)),
    'production.challanLines.runInputs': read(
      'What runs have claimed from these reception lines that stock does not show yet.',
      listArg('lineIds'), 'rows', (i) => ports.runInputsForChallanLines(i.lineIds), list('rows')),
    'production.machines.assignedToActiveRun': read(
      'Whether a live run has this machine on any node.', one('machineId'), 'assigned',
      (i) => ports.machineAssignedToActiveRun(i.machineId),
      { fields: { assigned: { type: 'boolean', required: true } } }),
    'production.dies.assignedToActiveRun': read(
      'Whether a live run has this die on any node.', one('dieId'), 'assigned',
      (i) => ports.dieAssignedToActiveRun(i.dieId),
      { fields: { assigned: { type: 'boolean', required: true } } }),
    'production.templates.runCount': read(
      'How many runs, ongoing or finished, were started from a template.', one('templateId'),
      'count', (i) => ports.templateRunCount(i.templateId),
      { fields: { count: { type: 'integer', required: true, min: 0 } } }),

    // The two that change production's rows for another module. Deleting an
    // order line does both inside its own transaction, so they must run there.
    'production.runs.dissolve': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Remove a run and the stock inputs recorded on it. The caller has put the stock back.',
      input: one('runId'),
      run: async (given) => {
        await ports.runs.dissolve(given.runId);
        return { ok: true };
      },
    },
    'production.runs.unlinkOrderItem': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Forget an order line’s runs: the line is being deleted.',
      input: one('orderItemId'),
      run: async (given) => {
        await ports.runs.unlinkOrderItem(given.orderItemId);
        return { ok: true };
      },
    },
  };
}

module.exports = function productionOperations({ work, ports, outputRow }) {
  /// The plain request a work function reads.
  const asked = (ctx, { params = {}, query = {}, body } = {}) => ({
    params,
    query,
    body,
    user: ctx.actor?.user || null,
  });
  const stock = (input) => ({
    params: { id: input.runId, nodeId: input.nodeId, barcode: input.barcode },
    query: input.quantity === undefined ? {} : { quantity: input.quantity },
    body: input.data,
  });

  return {
    ...internalOperations(ports),

    'production.output.row': {
      internal: true,
      summary: 'A finished-output record with its item name, or nothing. A challan line may deliver from one.',
      input: { fields: { productionRunId: { type: 'any', required: true } } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await outputRow(input.productionRunId) }),
    },

    'production.runs.list': {
      access: 'signedIn',
      summary: 'Runs, newest first; with templateId, only that template’s.',
      input: { fields: { templateId: any } },
      output: rows('runs'),
      run: async (input, ctx) =>
        answered(await work.listRuns(asked(ctx, { query: { template_id: input.templateId } }))),
    },

    'production.runs.get': {
      access: 'signedIn',
      summary: 'One run.',
      input: { fields: { runId } },
      output: runResult,
      run: async (input, ctx) => answered(await work.getRun(asked(ctx, { params: { id: input.runId } }))),
    },

    'production.runs.start': {
      permission: 'config.write',
      summary: 'Start a run from a pipeline template, for an order line, an order, or nothing.',
      input: { fields: { data } },
      output: runResult,
      run: async (input, ctx) => answered(await work.startRun(asked(ctx, { body: input.data }))),
    },

    'production.runs.delete': {
      permission: 'config.write',
      summary: 'Remove a run, with its inputs and scrap rows.',
      input: { fields: { runId } },
      run: async (input, ctx) => answered(await work.deleteRun(asked(ctx, { params: { id: input.runId } }))),
    },

    'production.runs.setNodeStatus': {
      permission: 'config.write',
      summary: 'Set a node’s status. Completing the last node books and mints the output.',
      input: { fields: { runId, data } },
      run: async (input, ctx) =>
        answered(await work.setNodeStatusFor(asked(ctx, { params: { id: input.runId }, body: input.data }))),
    },

    'production.runs.setNodeMetrics': {
      permission: 'config.write',
      summary: 'Record a stage’s reconciliation numbers: allotted, output, scrap, leftover.',
      input: { fields: { runId, data } },
      run: async (input, ctx) =>
        answered(await work.setNodeMetrics(asked(ctx, { params: { id: input.runId }, body: input.data }))),
    },

    'production.runs.setBatches': {
      permission: 'config.write',
      summary: 'Replace a run’s batches, as the client keeps them.',
      input: { fields: { runId, data } },
      run: async (input, ctx) =>
        answered(await work.setBatches(asked(ctx, { params: { id: input.runId }, body: input.data }))),
    },

    'production.runs.assignStock': {
      permission: 'config.write',
      summary: 'Put stock on a node: a material, a vendor sheet, or a quantity split over barcodes.',
      input: { fields: { runId, data } },
      run: async (input, ctx) =>
        answered(await work.assignStock(asked(ctx, { params: { id: input.runId }, body: input.data }))),
    },

    'production.runs.changeStock': {
      permission: 'config.write',
      summary: 'Change how much of a barcode a node took.',
      input: { fields: { runId, nodeId: any, barcode: any, quantity: any, data } },
      run: async (input, ctx) => answered(await work.changeStock(asked(ctx, stock(input)))),
    },

    'production.runs.removeStock': {
      permission: 'config.write',
      summary: 'Take a barcode back off a node and return what it had taken.',
      input: { fields: { runId, nodeId: any, barcode: any, data } },
      run: async (input, ctx) => answered(await work.removeStock(asked(ctx, stock(input)))),
    },

    'production.scrap.record': {
      access: OLD_WRITE_GATE,
      summary: 'Book scrap against a run’s node.',
      input: { fields: { data } },
      run: async (input, ctx) => answered(await work.recordScrap(asked(ctx, { body: input.data }))),
    },

    'production.scrap.list': {
      access: 'signedIn',
      summary: 'Scrap rows, newest first; optionally one run’s, or one node’s.',
      input: { fields: { pipelineRunId: any, nodeId: any } },
      output: rows('data'),
      run: async (input, ctx) =>
        answered(await work.listScrap(asked(ctx, {
          query: {
            ...(input.pipelineRunId === undefined ? {} : { pipelineRunId: input.pipelineRunId }),
            ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
          },
        }))),
    },

    'production.output.completed': {
      permission: 'production.read',
      summary: 'Finished output a delivery challan can be raised for.',
      input: { fields: { search: any, q: any, limit: any } },
      output: rows('productionRuns'),
      run: async (input, ctx) =>
        answered(await work.completedOutput(asked(ctx, {
          query: { search: input.search, q: input.q, limit: input.limit },
        }))),
    },

    'production.machines.queue': {
      permission: 'machines.read',
      summary: 'The live runs that name a machine.',
      input: { fields: { machineId: { type: 'any', required: true } } },
      output: rows('queue'),
      run: async (input, ctx) =>
        answered(await work.machineQueue(asked(ctx, { params: { id: input.machineId } }))),
    },

    'production.items.pipelineHistory': {
      permission: 'items.read',
      summary: 'The runs that made an item, and its default pipeline.',
      input: { fields: { itemId: { type: 'any', required: true } } },
      output: rows('runs'),
      run: async (input, ctx) =>
        answered(await work.itemPipelineHistory(asked(ctx, { params: { id: input.itemId } }))),
    },
  };
};

module.exports.answered = answered;
