'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the people module.
//
// People (employees, departments, logins) is still in server.js, so this is a
// thin reader over its tables, not yet a boundary with a service behind it. It
// exists so a module that has left (jobs today) does not carry SQL against
// `employees`. When people moves, this file is the contract it keeps.
// Read-only on purpose.
// ---------------------------------------------------------------------------

function createPeoplePorts({ get }) {
  return {
    /// The employee whose barcode this is, or null.
    async employeeIdByBarcode(barcodeId) {
      const row = await get('SELECT id FROM employees WHERE barcode_id = ?', [barcodeId]);
      return row ? row.id : null;
    },
  };
}

module.exports = { createPeoplePorts };
