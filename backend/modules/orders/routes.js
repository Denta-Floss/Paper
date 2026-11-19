'use strict';

// ---------------------------------------------------------------------------
// Orders over HTTP: the lines themselves.
//
//   GET    /api/orders                          the list (paged, searchable)
//   GET    /api/orders/:id                      one line, numeric ids only
//   POST   /api/orders                          add a line, or merge into one
//   PUT    /api/orders/:id                      edit a line
//   PATCH  /api/orders/:id/lifecycle            move it along its lifecycle
//   DELETE /api/orders/:id                      remove a line and what hangs off it
//   GET    /api/orders/:id/activity             who did what
//   GET    /api/orders/:id/status-history       how its status moved
//   GET    /api/orders/:id/material-requirements
//   GET    /api/orders/:id/po-documents         its purchase-order documents
//   POST   /api/orders/:id/po-documents         link uploaded documents to it
//   POST   /api/order-po-uploads/intent         ask for somewhere to upload one
//   POST   /api/order-po-uploads/complete       say it arrived
//   POST   /api/order-po-documents/:id/read-url a link to read one
//
// `orders`, `order-po-uploads` and `order-po-documents` are first path segments,
// so the central CRUD gate maps these to the orders module. Handlers are the
// ones that lived in server.js, moved whole, oddities included (each is pinned
// in orders-routes.test.js):
//   - GET /:id answers numeric ids only and passes anything else on, which is
//     what lets /api/orders/fulfilment be reached;
//   - PUT answers with the raw database row, not the DTO;
//   - DELETE answers success for an id that is not there;
//   - DELETE dissolves a line's runs and puts consumed stock back.
//
// The lines' own work — list, get, save, edit, lifecycle, delete — is asked for
// at the kernel desk (./operations.js); a handler here translates a request
// into an operation's input and its result into the answer the app has always
// had. Purchase-order documents still call the service directly.
// ---------------------------------------------------------------------------

module.exports = function registerOrderRoutes(ctx) {
  const {
    app,
    all,
    desk,
    requirePermission,
    cacheMasterData,
    orders,
  } = ctx;

  const ask = (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) });

  app.get('/api/orders', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      const result = await ask(req, 'orders.list', {
        search: req.query.search,
        clientId: req.query.client_id || req.query.clientId,
        statuses: req.query.status,
        ids: req.query.ids,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, orders: [], error: result.error });
        return;
      }
      const { ok, ...page } = result;
      res.json({ success: true, ...page, error: null });
    } catch (error) {
      res.status(500).json({ success: false, orders: [], error: error.message });
    }
  });

  /// One order line, shaped exactly like a row of the list.
  ///
  /// The delta engine knows only (table, record_id) when a change arrives, so it
  /// needs to fetch that single record.
  ///
  /// A single path segment, so it cannot shadow the `/api/orders/:id/activity`
  /// family registered around it.
  app.get('/api/orders/:id', requirePermission('config.read'), cacheMasterData, async (req, res, next) => {
    // Numeric ids only, so this cannot swallow a sibling named path.
    // `/api/orders/fulfilment` is one segment too, and a bare `:id` captured it
    // and answered 404 — a wildcard registered before a literal wins, and the
    // literal is easy to miss among thirty routes. Guarding on shape makes the
    // route order-independent instead of order-dependent.
    if (!/^\d+$/.test(String(req.params.id || ''))) {
      next();
      return;
    }
    try {
      const result = await ask(req, 'orders.get', { id: req.params.id });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, order: null, error: result.error });
        return;
      }
      res.json({ success: true, order: result.order, error: null });
    } catch (error) {
      res.status(500).json({ success: false, order: null, error: error.message });
    }
  });

  app.post('/api/orders', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'orders.save', { ...(req.body || {}) });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, order: null, error: result.error });
        return;
      }
      const { ok, ...saved } = result;
      res.status(saved.merged ? 200 : 201).json({ success: true, ...saved, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        order: null,
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-uploads/intent', requirePermission('config.write'), async (req, res) => {
    try {
      const intent = await orders.createPoUploadIntent(req.body || {});
      res.status(intent.alreadyUploaded ? 200 : 201).json({
        success: true,
        intent,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        intent: null,
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-uploads/complete', requirePermission('config.write'), async (req, res) => {
    try {
      const document = await orders.completePoUpload(req.body || {});
      res.json({ success: true, document, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        document: null,
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/po-documents', requirePermission('config.read'), async (req, res) => {
    try {
      const documents = await orders.getPoDocumentsForOrder(Number(req.params.id));
      res.json({ success: true, documents, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        documents: [],
        error: error.message,
      });
    }
  });

  app.post('/api/orders/:id/po-documents', requirePermission('config.write'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const { newlyLinkedIds } = await orders.linkPoDocumentsToOrder(orderId, req.body?.documentIds || []);
      if (newlyLinkedIds.length > 0) {
        const actor = {
          id: req.user?.id || null,
          name: req.user?.name || 'System',
          role: req.user?.role || 'system',
          source: 'api'
        };
        await orders.insertOrderActivityLog({
          orderId,
          activityType: 'po_documents_linked',
          actor,
          details: { documentIds: newlyLinkedIds },
        });
      }
      const documents = await orders.getPoDocumentsForOrder(orderId);
      res.json({ success: true, documents, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        documents: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/material-requirements', requirePermission('config.read'), async (req, res) => {
    try {
      const requirements = await all(
        'SELECT * FROM order_material_requirements WHERE order_id = ? ORDER BY id ASC',
        [Number(req.params.id)]
      );
      res.json({ success: true, requirements, error: null });
    } catch (error) {
      res.status(500).json({
        success: false,
        requirements: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/activity', requirePermission('config.read'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const rows = await orders.getOrderActivity(orderId);
      res.json({ success: true, activities: rows.map(orders.rowToOrderActivityDto), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        activities: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/status-history', requirePermission('config.read'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const rows = await orders.getOrderStatusHistory(orderId);
      res.json({ success: true, history: rows.map(orders.rowToOrderStatusHistoryDto), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        history: [],
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-documents/:id/read-url', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await orders.createPoDocumentReadUrl(Number(req.params.id));
      res.json({ success: true, ...result, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        document: null,
        readUrl: null,
        error: error.message,
      });
    }
  });

  app.patch('/api/orders/:id/lifecycle', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'orders.lifecycle.set', {
        ...(req.body || {}),
        id: Number(req.params.id),
      });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, order: null, error: result.error });
        return;
      }
      res.json({ success: true, order: result.order, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        order: null,
        error: error.message,
      });
    }
  });

  app.put('/api/orders/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'orders.edit', {
        ...(req.body || {}),
        id: Number(req.params.id),
      });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, order: result.order, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/orders/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'orders.delete', {
        id: Number(req.params.id),
        wipBarcode: req.body?.wip_barcode,
        wipQty: req.body?.wip_qty,
      });
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, recoveredMovements: result.recoveredMovements, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });
};
