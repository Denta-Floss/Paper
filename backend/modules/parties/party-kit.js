'use strict';

// ---------------------------------------------------------------------------
// What clients and vendors have in common: how a party's name and GST number
// are compared, and what still names a party when someone tries to delete it.
//
// Lived in server.js, three functions between two modules. Both the clients and
// the vendors module need them, and neither may import the other (K5), so they
// sit here beside contacts.js, which is the other thing a party is.
// ---------------------------------------------------------------------------

/// Names compare case-, space- and run-of-space-insensitively.
function normalizePartyValue(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

/// GST numbers compare with no spaces at all, upper-cased.
function normalizeGstNumber(value = '') {
  return String(value).trim().replace(/\s+/g, '').toUpperCase();
}

/// What still names this party, as "3 order lines" phrases. Delete skipped the
/// check archive makes, and trashAndDelete runs with foreign keys off — so a
/// deleted client left order lines, sub-contractors and parts pointing at a
/// row that was gone.
///
/// A vendor is named by challans, which another module owns, so that count is
/// asked of the challans port rather than read from its table here. A client's
/// blockers are still plain SQL: its own move will turn them into ports.
function createPartyDeleteBlockers({ get, challans }) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  return async function partyDeleteBlockers(table, id) {
    const blockers = [];
    const note = (count, word) => {
      if (count > 0) blockers.push(plural(count, word));
    };

    if (table === 'clients') {
      const checks = [
        ['SELECT COUNT(*) AS c FROM order_items WHERE client_id = ?', 'order line'],
        ['SELECT COUNT(*) AS c FROM sub_contractors WHERE client_id = ?', 'sub-contractor'],
        ['SELECT COUNT(*) AS c FROM items WHERE developed_for_client_id = ?', 'part'],
      ];
      for (const [sql, word] of checks) {
        const row = await get(sql, [id]);
        note(Number(row?.c || 0), word);
      }
    } else {
      note(Number(await challans.vendorUsageCount(id)) || 0, 'challan');
    }
    return blockers;
  };
}

module.exports = {
  normalizePartyValue,
  normalizeGstNumber,
  createPartyDeleteBlockers,
};
