'use strict';

// ---------------------------------------------------------------------------
// Links — what the kernel's link graph offers other modules at the desk. A
// part's section tree is kept as links under its own relation; items asks for
// them and adds or removes one at a time, inside the item's save.
// ---------------------------------------------------------------------------

const F = require('../../kernel/fields');

module.exports = function linkOperations({ all, run }) {
  return {
    'links.byRelation': {
      internal: true,
      summary: 'Every link under one relation name.',
      input: { fields: { relation: F.text } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({
        ok: true,
        rows: await all('SELECT id, left_type, left_id, right_type, right_id FROM entity_links WHERE relation = ?', [input.relation]),
      }),
    },

    'links.remove': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Remove one link by its id.',
      input: { fields: { id: F.int } },
      run: async (input) => {
        await run('DELETE FROM entity_links WHERE id = ?', [input.id]);
        return { ok: true };
      },
    },

    'links.removeRelation': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Remove every link under one relation name: a deleted part takes its section tree with it.',
      input: { fields: { relation: F.text } },
      run: async (input) => {
        await run('DELETE FROM entity_links WHERE relation = ?', [input.relation]);
        return { ok: true };
      },
    },

    'links.add': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Add a link under a relation, if it is not there already. Answers how many rows that added (0 or 1).',
      input: {
        fields: {
          leftType: F.text, leftId: F.text, rightType: F.text, rightId: F.text,
          relation: F.text, metadata: F.text, at: F.text,
        },
      },
      output: { fields: { changes: { type: 'integer', required: true, min: 0 } } },
      run: async (input) => {
        const result = await run(
          `INSERT OR IGNORE INTO entity_links
             (left_type, left_id, right_type, right_id, relation, metadata, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          [input.leftType, input.leftId, input.rightType, input.rightId, input.relation, input.metadata, input.at],
        );
        return { ok: true, changes: result?.changes || 0 };
      },
    },
  };
};
