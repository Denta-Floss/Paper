'use strict';

// What other modules ask of jobs, written down once (see the note on ASKS in
// kernel/desk-kit.js). Both are production's: an Assembly stage coming up makes
// or updates a job, and scrap booked against that stage is a rejection on it.

module.exports = [
  { port: 'syncAssemblyJob', args: ['assembly'],
    summary: 'Make or update the job for an Assembly stage of a run.' },
  { port: 'propagateAssemblyRejection', args: ['runId', 'nodeId', 'metrics'],
    summary: 'Carry scrap booked against an Assembly stage onto its job as rejections.' },
];
