'use strict';

// ---------------------------------------------------------------------------
// Jobs (the freelancer job pool) — what the module offers at the kernel desk.
//
//   offered to users
//     jobs.list · jobs.create · jobs.update · jobs.delete
//     jobs.batches.create · jobs.portalData
//
//   internal — asked by production (./asks.js, reached through ./client.js)
//     jobs.syncAssemblyJob · jobs.propagateAssemblyRejection
//
// WHO MAY ASK. /api/freelancer-jobs and /api/freelancer-portal map to no module
// in the central gate, so nothing here was ever behind a jobs permission: any
// signed-in session reads, and the old write gate decides the rest. The
// operations ask exactly that.
// ---------------------------------------------------------------------------

const { runMoved, joinOperations, operationsFromAsks } = require('../../kernel/desk-kit');
const ASKS = require('./asks');

// What the old write gate asks of a POST to a path no module claims.
const OLD_WRITE_GATE = {
  anyRole: ['super_admin', 'admin'],
  anyPermission: ['config.write', 'inventory.update'],
};
const loose = { type: 'any' };

module.exports = function jobOperations({ work, service }) {
  return joinOperations(operationsFromAsks('jobs', ASKS, service), {
    'jobs.list': {
      access: 'signedIn',
      summary: 'Everything the job board draws: batches, jobs and tasks.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.listJobs, ctx, { query: input.query || {}, body: input.data }),
    },

    'jobs.batches.create': {
      access: OLD_WRITE_GATE,
      summary: 'Hand a batch of jobs to a worker; assembly sets go out of stock with it.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.createJobBatches, ctx, { query: input.query || {}, body: input.data }),
    },

    'jobs.create': {
      access: OLD_WRITE_GATE,
      summary: 'Create a job for an item, with tasks from its bill of materials.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.createJob, ctx, { query: input.query || {}, body: input.data }),
    },

    'jobs.update': {
      access: OLD_WRITE_GATE,
      summary: 'Move a job along its status.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.updateJob, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'jobs.delete': {
      access: OLD_WRITE_GATE,
      summary: 'Remove a job and its tasks.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.deleteJob, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'jobs.portalData': {
      access: 'signedIn',
      summary: 'A freelancer’s own batches, jobs and tasks, by the token on their card.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(work.portalData, ctx, { query: input.query || {}, body: input.data }),
    },
  });
};
