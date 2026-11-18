'use strict';

// ---------------------------------------------------------------------------
// The B2B portal's work: a client's portal login, the list of items it may
// order, its cart, and turning the cart into an order.
//
// These were the bodies of the seven handlers in portal-routes.js, moved whole.
// Each answers a result and knows nothing of HTTP; they are published at the
// kernel desk as clients.portal.* (./operations.js).
//
// A portal password is stored only as a salted hash (the same one staff
// passwords use, handed in as hashPassword and verifyPassword). Passwords
// stored before that as plain text are hashed in place when the server starts
// and again before any login is checked, so none is ever compared as text.
// There is no built-in account: only a buyer a client was given signs in.
//
// As it was, and not changed here: a catalogue item that has variations cannot
// be ordered. The portal sends no variation selection and the order line
// requires one.
//
// Placing an order owns one transaction (header, every line, the cart clear).
// The header and the lines are the orders module's, asked for at the desk;
// the line save is told not to open a transaction of its own.
// ---------------------------------------------------------------------------

function createPortalService({ get, all, run, desk, hashPassword, verifyPassword }) {
  const no = (status, error) => ({ ok: false, status, error });

  /// Hashes, in place, every stored password that is still plain text. Safe to
  /// call any number of times; answers how many it changed.
  async function hashStoredPlainPasswords() {
    const rows = await all(
      "SELECT id, password_hash FROM portal_users WHERE password_hash IS NOT NULL AND password_hash NOT LIKE 'pbkdf2$%'",
    );
    for (const row of rows) {
      await run('UPDATE portal_users SET password_hash = ? WHERE id = ?', [
        hashPassword(row.password_hash),
        row.id,
      ]);
    }
    return rows.length;
  }

  async function setCredentials(clientId, { email, password } = {}) {
    if (!email || !password) return no(400, 'Email and password required');
    const hash = hashPassword(password);

    // UPSERT portal_users for this client
    const existing = await get('SELECT id FROM portal_users WHERE client_id = ?', [clientId]);
    if (existing) {
      await run('UPDATE portal_users SET email = ?, password_hash = ? WHERE client_id = ?', [email, hash, clientId]);
    } else {
      await run('INSERT INTO portal_users (client_id, email, password_hash) VALUES (?, ?, ?)', [clientId, email, hash]);
    }
    return { ok: true };
  }

  async function catalogItemIds(clientId) {
    const rows = await all('SELECT item_id FROM client_portal_catalog WHERE client_id = ?', [clientId]);
    return { ok: true, itemIds: rows.map((r) => r.item_id) };
  }

  async function replaceCatalog(clientId, itemIds) {
    try {
      await run('BEGIN TRANSACTION');
      await run('DELETE FROM client_portal_catalog WHERE client_id = ?', [clientId]);

      for (const itemId of itemIds) {
        await run('INSERT INTO client_portal_catalog (client_id, item_id) VALUES (?, ?)', [clientId, itemId]);
      }

      await run('COMMIT');
      return { ok: true };
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function login({ email, password } = {}) {
    if (!email || !password) return no(401, 'Invalid credentials');
    await hashStoredPlainPasswords();
    const user = await get('SELECT * FROM portal_users WHERE email = ? AND is_active = 1', [email]);
    if (user && verifyPassword(password, user.password_hash)) {
      return { ok: true, user: { id: user.id, email: user.email, client_id: user.client_id } };
    }
    return no(401, 'Invalid credentials');
  }

  async function catalog(clientId) {
    if (!clientId) return no(400, 'client_id query parameter is required');

    // The catalogue (which items a client may order) is this module's; what an
    // item is belongs to items, which is asked for the unarchived rows.
    const listed = await all(
      'SELECT item_id FROM client_portal_catalog WHERE client_id = ?',
      [clientId],
    );
    const { rows: items } = await desk.ask('items.rows.forCatalogue', {
      ids: listed.map((row) => row.item_id),
    });
    return { ok: true, items };
  }

  async function addToCart({ portal_user_id, item_id, quantity } = {}) {
    if (!portal_user_id || !item_id) return no(400, 'Missing required fields');

    const existing = await get('SELECT * FROM portal_carts WHERE portal_user_id = ? AND item_id = ?', [portal_user_id, item_id]);
    if (existing) {
      await run('UPDATE portal_carts SET quantity = quantity + ? WHERE id = ?', [quantity, existing.id]);
    } else {
      await run('INSERT INTO portal_carts (portal_user_id, item_id, quantity) VALUES (?, ?, ?)',
        [portal_user_id, item_id, quantity]);
    }
    return { ok: true };
  }

  async function placeOrder({ portal_user_id, items } = {}) {
    try {
      if (!portal_user_id || !items || !items.length) return no(400, 'Missing required fields');

      const pUser = await get('SELECT * FROM portal_users WHERE id = ?', [portal_user_id]);
      if (!pUser) return no(404, 'Portal user not found');

      await run('BEGIN TRANSACTION');

      const orderNo = 'B2B-ORD-' + Date.now();

      // Create header
      await desk.ask('orders.portal.insertHeader', { orderNo, clientId: pUser.client_id });

      // Save items
      for (const item of items) {
        // This owns the transaction (header, every line and the cart clear land
        // together), and SQLite has no nested BEGIN, so the line save must not
        // open its own.
        await desk.ask('orders.portal.saveLine', {
          line: {
            orderNo,
            clientId: pUser.client_id,
            itemId: item.item_id,
            quantity: item.quantity,
            status: 'draft',
            createdByPortalUserId: portal_user_id,
          },
        });
      }

      // Clear cart
      await run('DELETE FROM portal_carts WHERE portal_user_id = ?', [portal_user_id]);

      await run('COMMIT');
      return { ok: true, orderNo };
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  return {
    setCredentials,
    hashStoredPlainPasswords,
    catalogItemIds,
    replaceCatalog,
    login,
    catalog,
    addToCart,
    placeOrder,
  };
}

module.exports = { createPortalService };
