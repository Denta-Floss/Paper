'use strict';

// Jobs, as a module that is not jobs sees it: the two functions production
// calls, asked for at the kernel desk (see ./asks.js).

const ASKS = require('./asks');
const { clientFromAsks } = require('../../kernel/desk-kit');

const jobsClient = (desk) => clientFromAsks('jobs', ASKS, desk);

module.exports = { jobsClient };
