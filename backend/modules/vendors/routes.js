'use strict';

// ---------------------------------------------------------------------------
// The vendor master over HTTP.
//
//   GET    /api/vendors                        everyone, archived last
//   GET    /api/vendors/:id                    one, with how many challans name it
//   GET    /api/vendors/:id/purchase-history   what they have delivered to us
//   POST   /api/vendors                        add one
//   PATCH  /api/vendors/:id                    change one
//   DELETE /api/vendors/:id                    remove one nothing names
//
// `vendors` is the first path segment, so the central CRUD gate maps every
// route here to the vendors module. Handlers are the ones that lived in
// server.js, moved whole; the only difference is where they reach their
// neighbours: the vendor service for the master itself, the challans port for
// anything that lives in a challan.
// ---------------------------------------------------------------------------

module.exports = function registerVendorRoutes(ctx) {
  const {
    app,
    get,
    requirePermission,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    partyDeleteBlockers,
    getIo,
    vendors,
    challans,
    itemsPorts,
  } = ctx;

  const emit = (event, payload) => {
    const io = getIo();
    if (io) {
      io.emit(event, payload);
    }
  };

  app.get('/api/vendors', requirePermission('config.read'), async (_req, res) => {
    try {
      const rows = await vendors.getVendorsWithUsage();
      res.json({ success: true, vendors: rows.map(vendors.rowToVendorDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, vendors: [], error: error.message });
    }
  });

  app.get('/api/vendors/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const row = await vendors.getVendorRowById(req.params.id);
      if (!row) {
        return res.status(404).json({ success: false, vendor: null, error: 'Not found' });
      }
      res.json({ success: true, vendor: vendors.rowToVendorDto(row), error: null });
    } catch (error) {
      res.status(500).json({ success: false, vendor: null, error: error.message });
    }
  });

  app.get('/api/vendors/:id/purchase-history', requirePermission('config.read'), async (req, res) => {
    try {
      const vendorId = Number(req.params.id);
      const rows = await challans.vendorPurchaseRows(vendorId);

      const historyItems = [];
      for (const r of rows) {
        const itemDesc = await itemsPorts.describe(r.item_id);
        historyItems.push({
          itemId: r.item_id,
          variationLeafNodeId: r.variation_leaf_node_id,
          variationPathLabel: r.variation_path_label,
          variationPathNodeIds: JSON.parse(r.variation_path_node_ids_json || '[]'),
          customVariationValues: JSON.parse(r.custom_variation_values_json || '{}'),
          particulars: r.particulars || itemDesc?.name || 'Unknown Item',
        });
      }

      // Deduplicate on backend just in case DISTINCT missed something due to JSON differences
      const uniqueItems = [];
      const seen = new Set();
      for (const item of historyItems) {
        const key = `${item.itemId}_${item.variationLeafNodeId}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueItems.push(item);
        }
      }

      res.json({ success: true, history: uniqueItems, error: null });
    } catch (error) {
      res.status(500).json({ success: false, history: [], error: error.message });
    }
  });

  app.post('/api/vendors', requirePermission('config.write'), async (req, res) => {
    try {
      const vendor = await vendors.saveVendor(req.body || {});
      const vendorDto = vendors.rowToVendorDto(vendor);
      emit('vendor_added', vendorDto);
      trackCreate('vendors', vendor.id, vendor, req);
      res.status(201).json({ success: true, vendor: vendorDto, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, vendor: null, error: error.message });
    }
  });

  app.delete('/api/vendors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await get('SELECT * FROM vendors WHERE id = ?', [id]);
      const blockers = await partyDeleteBlockers('vendors', id);
      if (blockers.length > 0) {
        return res.status(409).json({
          success: false,
          code: 'vendor_in_use',
          error: `"${before?.name || 'This vendor'}" is still named on ${blockers.join(' and ')}. `
            + 'Archive it instead.',
        });
      }
      await trashAndDelete('vendors', id, req);
      trackDelete('vendors', id, before, req);
      emit('vendor_deleted', { id });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/vendors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await get('SELECT * FROM vendors WHERE id = ?', [id]);
      const vendor = await vendors.saveVendor({
        ...(req.body || {}),
        id,
      });
      const vendorDto = vendors.rowToVendorDto(vendor);
      emit('vendor_updated', vendorDto);
      const after = await get('SELECT * FROM vendors WHERE id = ?', [id]);
      trackUpdate('vendors', id, before, after, req);
      res.json({ success: true, vendor: vendorDto, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, vendor: null, error: error.message });
    }
  });
};
