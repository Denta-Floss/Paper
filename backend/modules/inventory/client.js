'use strict';

// ---------------------------------------------------------------------------
// Inventory, as a module that is not inventory sees it.
//
// inventoryClient(desk) returns an object shaped exactly like ./ports.js
// (movements.apply, receipts.mintLot, …), and every function on it asks the
// kernel desk for the matching internal operation. `desk` is the calling
// module's own handle (desk.as('challans')), so each call is checked against
// what that module has declared it uses, counted, and held to the operation's
// contract.
//
// A caller written against the ports does not change: it is handed this
// instead. What it can no longer do is reach an inventory function nobody
// published.
// ---------------------------------------------------------------------------

const ASKS = require('./asks');
const { clientFromAsks } = require('../../kernel/desk-kit');

const inventoryClient = (desk) => clientFromAsks('inventory', ASKS, desk);

module.exports = { inventoryClient };
