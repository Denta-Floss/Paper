'use strict';

// ---------------------------------------------------------------------------
// Vendors module — HTTP routes.
//
// All 6 route registrations for vendors territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerVendorsModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    saveVendor,
    rowToVendorDto,
    getVendorsWithUsage,
    getVendorRowById,
    getVendorPurchaseHistory,
    itemsPorts,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    getIo,
  } = ctx;

app.get('/api/vendors', requirePermission('config.read'), async (_req, res) => {
  try {
    const rows = await getVendorsWithUsage();
    res.json({ success: true, vendors: rows.map(rowToVendorDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, vendors: [], error: error.message });
  }
});

app.get('/api/vendors/:id', requirePermission('config.read'), async (req, res) => {
  try {
    // getVendorRowById already returns the row with usage_count sourced through
    // the challans port; this route had duplicated that SQL verbatim.
    const row = await getVendorRowById(Number(req.params.id));
    if (!row) {
      return res.status(404).json({ success: false, vendor: null, error: 'Not found' });
    }
    res.json({ success: true, vendor: rowToVendorDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, vendor: null, error: error.message });
  }
});

app.get('/api/vendors/:id/purchase-history', requirePermission('config.read'), async (req, res) => {
  try {
    const vendorId = Number(req.params.id);
    const rows = await getVendorPurchaseHistory(vendorId);

    const historyItems = [];
    for (const r of rows) {
      const itemDesc = await itemsPorts.describe(r.item_id);
      historyItems.push({
        itemId: r.item_id,
        variationLeafNodeId: r.variation_leaf_node_id,
        variationPathLabel: r.variation_path_label,
        variationPathNodeIds: JSON.parse(r.variation_path_node_ids_json || '[]'),
        customVariationValues: JSON.parse(r.custom_variation_values_json || '{}'),
        particulars: r.particulars || itemDesc?.name || 'Unknown Item'
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
    const vendor = await saveVendor(req.body || {});
    const vendorDto = rowToVendorDto(vendor);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('vendor_added', vendorDto);
    }
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
    await trashAndDelete('vendors', id, req);
    trackDelete('vendors', id, before, req);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('vendor_deleted', { id });
    }
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/vendors/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = await get('SELECT * FROM vendors WHERE id = ?', [id]);
    const vendor = await saveVendor({
      ...(req.body || {}),
      id,
    });
    const vendorDto = rowToVendorDto(vendor);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('vendor_updated', vendorDto);
    }
    const after = await get('SELECT * FROM vendors WHERE id = ?', [id]);
    trackUpdate('vendors', id, before, after, req);
    res.json({ success: true, vendor: vendorDto, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, vendor: null, error: error.message });
  }
});

};
