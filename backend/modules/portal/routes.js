'use strict';

// ---------------------------------------------------------------------------
// Portal module — HTTP routes.
//
// All 4 route registrations for portal territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order matches
// server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerPortalModuleRoutes(ctx) {
  const {
    app,
    get,
    all,
    run,
    saveOrder,
  } = ctx;

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
          client_id: user.client_id 
        } 
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
    const items = ctx.getPortalCatalog
      ? await ctx.getPortalCatalog(clientId)
      : [];
    
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
    if (ctx.createPortalOrderHeader) {
      await ctx.createPortalOrderHeader(orderNo, pUser.client_id);
    }
      
    // Save items
    for (const item of items) {
      await saveOrder({
        orderNo,
        clientId: pUser.client_id,
        itemId: item.item_id,
        quantity: item.quantity,
        status: 'draft',
        createdByPortalUserId: portal_user_id,
      }, { returnMeta: false });
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
