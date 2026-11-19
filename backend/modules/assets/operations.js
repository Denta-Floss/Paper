'use strict';

// ---------------------------------------------------------------------------
// Assets — what the kernel's uploaded files offer other modules at the desk.
// A challan carries photos and documents; a set has a cover picture. The
// upload itself (intent, presigning, completion) is the kernel's routes.
// ---------------------------------------------------------------------------

const F = require('../../kernel/fields');

module.exports = function assetOperations({ get, all, run }) {
  return {
    'assets.forEntity': {
      internal: true,
      summary: 'The uploaded files attached to a record, oldest first.',
      input: { fields: { entityType: F.text, entityId: F.int } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({
        ok: true,
        rows: await all(
          "SELECT * FROM uploaded_assets WHERE entity_type = ? AND entity_id = ? AND status = 'uploaded' ORDER BY created_at ASC",
          [input.entityType, input.entityId],
        ),
      }),
    },

    'assets.primaryFor': {
      internal: true,
      summary: 'A record’s primary uploaded file, or its oldest when none is marked primary; or nothing.',
      input: { fields: { entityType: F.text, entityId: F.int } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({
        ok: true,
        row: (await get(
          `SELECT * FROM uploaded_assets
            WHERE entity_type = ? AND entity_id = ? AND status = 'uploaded'
            ORDER BY is_primary DESC, created_at ASC
            LIMIT 1`,
          [input.entityType, input.entityId],
        )) || null,
      }),
    },

    'assets.attachUploaded': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Record a file that is already in the store as attached to a record. A challan saves its photos this way, inside its own transaction.',
      input: {
        fields: {
          entityType: F.text, entityId: F.int, fileName: F.text, contentType: F.text,
          sizeBytes: F.int, sha256: F.text, objectKey: F.text, at: F.text,
        },
      },
      run: async (input) => {
        await run(
          `INSERT OR IGNORE INTO uploaded_assets (
             entity_type, entity_id, file_name, content_type, size_bytes, sha256,
             object_key, status, is_primary, created_at, uploaded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', 0, ?, ?)`,
          [input.entityType, input.entityId, input.fileName, input.contentType, input.sizeBytes || 0,
            input.sha256 || '', input.objectKey, input.at, input.at],
        );
        return { ok: true };
      },
    },

    'assets.sessionEntity': {
      internal: true,
      summary: 'Which record an upload session was opened for; or nothing.',
      input: { fields: { id: F.text } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({
        ok: true,
        row: (await get('SELECT entity_type, entity_id FROM asset_upload_sessions WHERE id = ?', [input.id])) || null,
      }),
    },
  };
};
