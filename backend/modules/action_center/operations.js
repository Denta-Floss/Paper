'use strict';

const F = require('../../kernel/fields');

// ---------------------------------------------------------------------------
// The action centre — what the module offers at the kernel desk.
//
//   offered to users
//     action_center.trash.list · .trash.restore
//     action_center.deleteRequests.list · .create · .approve · .reject · .export
//     action_center.issues
//
// WHO MAY ASK is what stood in front of each route. The trash and the issue
// scan are gated as the action centre. Delete requests are not: their paths
// are left out of the module gate, so reviewing them asks for
// `delete_requests.review`, approving or rejecting one also has to pass the old
// write gate, and anyone signed in may ask for a deletion.
//
// Approving a request deletes the record by asking the module that owns it
// (see the deleters in server.js): the action centre holds no other module's
// delete logic.
// ---------------------------------------------------------------------------

const { runMoved } = require('../../kernel/desk-kit');

// What the old write gate asks of a POST to a path no module claims.
const OLD_WRITE_GATE = {
  anyRole: ['super_admin', 'admin'],
  anyPermission: ['config.write', 'inventory.update'],
};

module.exports = function actionCenterOperations({ work }) {
  return {
    'action_center.trash.list': {
      permission: 'action_center.read',
      summary: 'What is in the trash.',
      input: { fields: { query: F.obj({ tableName: F.text }), data: F.none } },
      run: (input, ctx) => runMoved(work.listTrash, ctx, { query: input.query || {}, body: input.data }),
    },

    'action_center.trash.restore': {
      permission: 'action_center.create',
      summary: 'Put a trashed record back.',
      input: { fields: { query: F.none, data: F.obj({ tableName: F.text, recordId: { type: 'any' } }) } },
      run: (input, ctx) => runMoved(work.restoreTrash, ctx, { query: input.query || {}, body: input.data }),
    },

    'action_center.deleteRequests.list': {
      permission: 'delete_requests.review',
      summary: 'The delete requests waiting for review, and the reviewed ones.',
      input: { fields: { query: F.obj({ status: F.text, limit: F.int, offset: F.int, page: F.int }), data: F.none } },
      run: (input, ctx) => runMoved(work.listDeleteRequests, ctx, { query: input.query || {}, body: input.data }),
    },

    'action_center.deleteRequests.create': {
      access: 'signedIn',
      summary: 'Ask for a record to be deleted.',
      input: { fields: { query: F.none, data: F.obj({ entityType: F.text, entityId: { type: 'any' }, entityLabel: F.text, reason: F.text }) } },
      run: (input, ctx) => runMoved(work.createDeleteRequest, ctx, { query: input.query || {}, body: input.data }),
    },

    'action_center.deleteRequests.approve': {
      access: OLD_WRITE_GATE,
      permission: 'delete_requests.review',
      summary: 'Approve a delete request and delete the record.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ note: F.text }) } },
      run: (input, ctx) => runMoved(work.approveDeleteRequest, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'action_center.deleteRequests.reject': {
      access: OLD_WRITE_GATE,
      permission: 'delete_requests.review',
      summary: 'Reject a delete request.',
      input: { fields: { id: F.id, query: F.none, data: F.obj({ note: F.text }) } },
      run: (input, ctx) => runMoved(work.rejectDeleteRequest, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'action_center.deleteRequests.export': {
      permission: 'delete_requests.review',
      summary: 'Every delete request, as a CSV file.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(work.exportDeleteRequests, ctx, { query: input.query || {}, body: input.data }),
    },

    'action_center.issues': {
      permission: 'action_center.read',
      summary: 'References to records that are gone: an order naming a deleted client, an item in a deleted group.',
      input: { fields: { query: F.none, data: F.none } },
      run: (input, ctx) => runMoved(work.integrityIssues, ctx, { query: input.query || {}, body: input.data }),
    },
  };
};
