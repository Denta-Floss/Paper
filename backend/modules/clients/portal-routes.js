'use strict';

// ---------------------------------------------------------------------------
// The B2B portal: what a client's own buyer sees, and the three routes the
// shop uses to set that up.
//
//   POST /api/clients/:id/portal-credentials   give the client a login
//   GET  /api/clients/:id/portal-catalog       which items it may order
//   POST /api/clients/:id/portal-catalog       replace that list
//   POST /api/portal/login                     the buyer signs in
//   GET  /api/portal/catalog                   what the buyer may order
//   POST /api/portal/cart                      add to the cart
//   POST /api/portal/orders                    turn the cart into an order
//
// Moved whole from server.js; none of these carries requirePermission, and none
// did. The /api/clients/:id/... three are gated by the central CRUD gate as
// `clients`; the /api/portal/... four sit under a segment the gate does not map
// (`portal`), so they are open to any signed-in session, as before.
//
// Orders are placed through the orders port: the header insert and saveOrder.
//
// POST /api/portal/orders owns one transaction (header, lines, cart clear); the
// line save is told not to open its own. It used to, SQLite refused the nested
// BEGIN, and placing a portal order never succeeded.
//
// Still true: a catalogue item that has variations cannot be ordered here. The
// portal sends no variation selection and saveOrder requires one, so such an
// order fails (400 inside, 500 out). Only variation-free items go through.
// ---------------------------------------------------------------------------

module.exports = function registerClientPortalRoutes(ctx) {
  const { app, get, all, run, orders } = ctx;

  app.post('/api/clients/:id/portal-credentials', async (req, res) => {
    try {
      const clientId = req.params.id;
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
      }
      const hash = password; // Should hash password in production

      // UPSERT portal_users for this client
      const existing = await get('SELECT id FROM portal_users WHERE client_id = ?', [clientId]);
      if (existing) {
        await run('UPDATE portal_users SET email = ?, password_hash = ? WHERE client_id = ?', [email, hash, clientId]);
      } else {
        await run('INSERT INTO portal_users (client_id, email, password_hash) VALUES (?, ?, ?)', [clientId, email, hash]);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/clients/:id/portal-catalog', async (req, res) => {
    try {
      const rows = await all('SELECT item_id FROM client_portal_catalog WHERE client_id = ?', [req.params.id]);
      res.json({ success: true, itemIds: rows.map(r => r.item_id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/clients/:id/portal-catalog', async (req, res) => {
    try {
      const clientId = req.params.id;
      const { itemIds } = req.body; // Array of item IDs

      await run('BEGIN TRANSACTION');
      await run('DELETE FROM client_portal_catalog WHERE client_id = ?', [clientId]);

      for (const itemId of itemIds) {
        await run('INSERT INTO client_portal_catalog (client_id, item_id) VALUES (?, ?)', [clientId, itemId]);
      }

      await run('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await run('ROLLBACK');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/portal/login', async (req, res) => {
    try {
      const { email, password } = req.body;

      // Check real portal users first
      const user = await get('SELECT * FROM portal_users WHERE email = ? AND is_active = 1', [email]);
      if (user && user.password_hash === password) { // simple string match for now
        return res.json({
          success: true,
          user: {
            id: user.id,
            email: user.email,
            client_id: user.client_id,
          },
        });
      }

      // Fallback to mock
      if (email === 'test@example.com' && password === 'password') {
        return res.json({ success: true, user: { id: 1, name: 'Test Client User', client_id: 1 } });
      }
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/portal/catalog', async (req, res) => {
    try {
      const clientId = req.query.client_id;
      if (!clientId) {
        return res.status(400).json({ success: false, error: 'client_id query parameter is required' });
      }

      // Only return items that aren't archived AND are in the client_portal_catalog
      const items = await all(`
        SELECT i.id, i.name, i.display_name, i.alias, i.quantity, i.naming_format
        FROM items i
        JOIN client_portal_catalog cpc ON i.id = cpc.item_id
        WHERE i.is_archived = 0 AND cpc.client_id = ?
        ORDER BY i.display_name ASC
      `, [clientId]);

      res.json({ success: true, items });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/portal/cart', async (req, res) => {
    try {
      const { portal_user_id, item_id, quantity } = req.body;
      if (!portal_user_id || !item_id) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }

      const existing = await get('SELECT * FROM portal_carts WHERE portal_user_id = ? AND item_id = ?', [portal_user_id, item_id]);
      if (existing) {
        await run('UPDATE portal_carts SET quantity = quantity + ? WHERE id = ?', [quantity, existing.id]);
      } else {
        await run('INSERT INTO portal_carts (portal_user_id, item_id, quantity) VALUES (?, ?, ?)',
          [portal_user_id, item_id, quantity]);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/portal/orders', async (req, res) => {
    try {
      const { portal_user_id, items, notes } = req.body;
      if (!portal_user_id || !items || !items.length) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }

      const pUser = await get('SELECT * FROM portal_users WHERE id = ?', [portal_user_id]);
      if (!pUser) return res.status(404).json({ success: false, error: 'Portal user not found' });

      await run('BEGIN TRANSACTION');

      const orderNo = 'B2B-ORD-' + Date.now();

      // Create header
      await orders.insertOrderHeader({ orderNo, clientId: pUser.client_id });

      // Save items
      for (const item of items) {
        // This route owns the transaction (header, every line and the cart
        // clear land together), and SQLite has no nested BEGIN, so the line
        // save must not open its own.
        await orders.saveOrder({
          orderNo,
          clientId: pUser.client_id,
          itemId: item.item_id,
          quantity: item.quantity,
          status: 'draft',
          createdByPortalUserId: portal_user_id,
        }, { returnMeta: false, useTransaction: false });
      }

      // Clear cart
      await run('DELETE FROM portal_carts WHERE portal_user_id = ?', [portal_user_id]);

      await run('COMMIT');
      res.json({ success: true, orderNo });
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
