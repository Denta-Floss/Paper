'use strict';

// Items, as a module that is not items sees it: an object shaped like
// ./ports.js whose every function asks the kernel desk (see ./asks.js). `desk`
// is the calling module's own handle, so each call is checked against what
// that module has declared it uses.

const ASKS = require('./asks');
const { clientFromAsks } = require('../../kernel/desk-kit');

const itemsClient = (desk) => clientFromAsks('items', ASKS, desk);

module.exports = { itemsClient };
