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
/// What names a party lives in other modules' tables, so each count is asked of
/// that module's port rather than read here: a vendor is named by challans, a
/// client by order lines (orders) and by the parts developed for it (items). Its
/// sub-contractors are the clients module's own and are read directly.
function createPartyDeleteBlockers({ get, challans, desk, items }) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  return async function partyDeleteBlockers(table, id) {
    const blockers = [];
    const note = (count, word) => {
      if (count > 0) blockers.push(plural(count, word));
    };

    if (table === 'clients') {
      note((await desk.ask('orders.clients.lineCount', { clientId: id })).count, 'order line');
      const subs = await get('SELECT COUNT(*) AS c FROM sub_contractors WHERE client_id = ?', [id]);
      note(Number(subs?.c || 0), 'sub-contractor');
      note(Number(await items.developedForCount(id)) || 0, 'part');
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
