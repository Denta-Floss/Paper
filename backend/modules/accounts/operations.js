'use strict';

// ---------------------------------------------------------------------------
// Accounts — what the kernel's user accounts offer other modules at the desk.
// People links an employee to a login and shows its email, role and staff
// code; nothing else reads the users table from a module.
// ---------------------------------------------------------------------------

const F = require('../../kernel/fields');

const loginFields = 'id, email, role, is_active, mobile_pin';

module.exports = function accountOperations({ get, all, run }) {
  return {
    'accounts.users.get': {
      internal: true,
      summary: 'A login account’s id, email, role, active flag and staff code; or nothing.',
      input: { fields: { id: F.int } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: (await get(`SELECT ${loginFields} FROM users WHERE id = ?`, [input.id])) || null }),
    },

    'accounts.users.byIds': {
      internal: true,
      summary: 'The same for several accounts at once.',
      input: { fields: { ids: F.list(F.int) } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => {
        const ids = [...new Set((input.ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
        if (!ids.length) return { ok: true, rows: [] };
        return { ok: true, rows: await all(`SELECT ${loginFields} FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`, ids) };
      },
    },

    'accounts.users.setMobilePin': {
      internal: true,
      joinsCallerTransaction: true,
      summary: 'Set an account’s 4-digit staff login code. People does this from the employee’s date of birth.',
      input: { fields: { id: F.int, pin: F.text, updatedAt: F.text } },
      run: async (input) => {
        if (input.updatedAt) {
          await run('UPDATE users SET mobile_pin = ?, updated_at = ? WHERE id = ?', [input.pin, input.updatedAt, input.id]);
        } else {
          await run('UPDATE users SET mobile_pin = ? WHERE id = ?', [input.pin, input.id]);
        }
        return { ok: true };
      },
    },
  };
};
