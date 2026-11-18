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
// None of these carries requirePermission, and none did. The /api/clients/:id/...
// three are gated by the central CRUD gate as `clients`. The /api/portal/... four
// sit under a segment the gate does not map (`portal`): a signed-in session may
// read, and the old write gate decides the POSTs.
//
// The work is in ./portal.js, published at the kernel desk as clients.portal.*
// (./operations.js). Each handler here translates a request into an operation's
// input and its result into the answer the portal app has always had, oddities
// included: a failed login that throws answers with `error` alone.
// ---------------------------------------------------------------------------

module.exports = function registerClientPortalRoutes(ctx) {
  const { app, desk } = ctx;
  const ask = (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) });
  const refuse = (res, result) =>
    res.status(result.status || 400).json({ success: false, error: result.error });

  app.post('/api/clients/:id/portal-credentials', async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await ask(req, 'clients.portal.setCredentials', {
        clientId: req.params.id,
        email,
        password,
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/clients/:id/portal-catalog', async (req, res) => {
    try {
      const result = await ask(req, 'clients.portal.catalogItemIds', { clientId: req.params.id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, itemIds: result.itemIds });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/clients/:id/portal-catalog', async (req, res) => {
    try {
      const { itemIds } = req.body; // Array of item IDs
      const result = await ask(req, 'clients.portal.replaceCatalog', {
        clientId: req.params.id,
        itemIds,
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/portal/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await ask(req, 'clients.portal.login', { email, password });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, user: result.user });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/portal/catalog', async (req, res) => {
    try {
      const result = await ask(req, 'clients.portal.catalog', { clientId: req.query.client_id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, items: result.items });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/portal/cart', async (req, res) => {
    try {
      const { portal_user_id, item_id, quantity } = req.body;
      const result = await ask(req, 'clients.portal.addToCart', { portal_user_id, item_id, quantity });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/portal/orders', async (req, res) => {
    try {
      const { portal_user_id, items } = req.body;
      const result = await ask(req, 'clients.portal.placeOrder', { portal_user_id, items });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, orderNo: result.orderNo });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
