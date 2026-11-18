'use strict';

// ---------------------------------------------------------------------------
// What the handlers in routes.js did, statement for statement. Instead of
// writing a response each returns answer(status, body), the same status and
// the same body (or answerFile for a download). A function takes a plain
// `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes these at the kernel desk; ./routes.js asks the desk.
// ---------------------------------------------------------------------------

const { answer, answerFile } = require('../../kernel/desk-kit');

function createActionCenterWork({ trash, deleteRequests }) {

  // GET /api/trash — list trashed records (most recent first), optionally filtered by table.
  async function listTrash(req) {
    try {
      const records = await trash.listTrash(req.query.tableName);
      return answer(200, { success: true, records, total: records.length, error: null });
    } catch (error) {
      return answer(500, { success: false, records: [], total: 0, error: error.message });
    }
  }

  // POST /api/trash/restore
  async function restoreTrash(req) {
    try {
      const tableName = String(req.body?.tableName || '');
      const recordId = Number(req.body?.recordId);
      const result = await trash.restore(tableName, recordId);
      if (result.refusal) {
        return answer(result.refusal.status, result.refusal.body);
      }
      return answer(200, { success: true, restored: result.restored, error: null });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  // --- delete requests ------------------------------------------------------

  async function listDeleteRequests(req) {
    try {
      const { requests, total } = await deleteRequests.listRequests(req.query);
      return answer(200, { success: true, requests, total });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function createDeleteRequest(req) {
    try {
      const made = await deleteRequests.createRequest(req.body, req.user.id);
      if (made.refusal) {
        return answer(made.refusal.status, made.refusal.body);
      }
      return answer(201, { success: true, request: made.request });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function approveDeleteRequest(req) {
    try {
      const done = await deleteRequests.approve(Number(req.params.id), {
        note: req.body?.note,
        reviewerId: req.user.id,
        req,
      });
      if (done.refusal) {
        return answer(done.refusal.status, done.refusal.body);
      }
      return answer(200, { success: true, request: done.request });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function rejectDeleteRequest(req) {
    try {
      const done = await deleteRequests.reject(Number(req.params.id), {
        note: req.body?.note,
        reviewerId: req.user.id,
      });
      if (done.refusal) {
        return answer(done.refusal.status, done.refusal.body);
      }
      return answer(200, { success: true, request: done.request });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function exportDeleteRequests(req) {
    try {
      const csv = await deleteRequests.exportCsv();
      return answerFile('text/csv', 'attachment; filename="delete_requests_export.csv"', csv);
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  // --- the integrity scan ---------------------------------------------------

  // Scans for broken foreign-key references caused by hard-deletes and returns a
  // structured list of issues the user can resolve.
  async function integrityIssues(req) {
    const { issues, scanErrors } = await deleteRequests.scanIntegrity();
    return answer(200, { success: true, issues, total: issues.length, scanErrors, error: null });
  }

  return {
    listTrash,
    restoreTrash,
    listDeleteRequests,
    createDeleteRequest,
    approveDeleteRequest,
    rejectDeleteRequest,
    exportDeleteRequests,
    integrityIssues,
  };
}

module.exports = { createActionCenterWork };
