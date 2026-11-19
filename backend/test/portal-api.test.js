const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The client portal's tables take a portal user for a client and a cart line
// for an item.
//
// Like payroll-api.test.js, this used to open the developer's own
// `backend/paper.db`, and failed on a clean checkout where that file does not
// exist. It now builds its own database.

test('a portal user for a client, and an item in their cart', async () => {
  const tempDir = makeTempDir('paper-portal-tables-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  const client = await backend.get('SELECT id FROM clients LIMIT 1');
  const item = await backend.get('SELECT id FROM items LIMIT 1');
  assert.ok(client && item, 'the demo seed has a client and an item');

  const user = await backend.run(
    'INSERT INTO portal_users (client_id, email, password_hash) VALUES (?, ?, ?)',
    [client.id, 'portal@example.com', 'hash'],
  );
  assert.ok(user.lastID > 0);

  await backend.run(
    'INSERT INTO portal_carts (portal_user_id, item_id, quantity) VALUES (?, ?, 5)',
    [user.lastID, item.id],
  );
  const cart = await backend.get('SELECT * FROM portal_carts WHERE portal_user_id = ?', [user.lastID]);
  assert.equal(cart.item_id, item.id);
  assert.equal(cart.quantity, 5);
});
