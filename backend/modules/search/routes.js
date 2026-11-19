'use strict';

// ---------------------------------------------------------------------------
// Search: finding a record by typing or by scanning. The global search, and
// the lookups a barcode gun or a phone camera lands on.
//
//   GET    /api/search
//   GET    /api/search/history
//   POST   /api/search/history
//   POST   /api/search/clicks
//   GET    /api/scan/:code
//   GET    /api/barcode/lookup
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
function registerSearchRoutes(app, {
  all,
  get,
  desk,
  itemsPorts,
  requirePermission,
  resolveBarcode,
  run,
}) {
  app.get('/api/search', requirePermission('inventory.read'), async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) {
        return res.json({ success: true, results: [] });
      }
    
      const tokens = q.split(/\s+/).filter(Boolean);
      // Each owner finds its own hits; search merges and ranks them.
      const { rows: items } = await desk.ask('items.search.hits', { tokens, limit: 50 });
      const { rows: materials } = await desk.ask('inventory.materials.search', { tokens, limit: 50 });

      const clicks = await all(
        `SELECT entity_type, entity_id, COUNT(*) as click_count 
         FROM search_clicks 
         WHERE user_id = ? 
         GROUP BY entity_type, entity_id`,
        [req.user.id]
      );
      const clickMap = {};
      for (const c of clicks) {
        clickMap[`${c.entity_type}_${c.entity_id}`] = c.click_count;
      }

      // Fetch configurations for items
      const itemConfigs = {};
      const itemIds = [...new Set(items.map(i => i.id))];
      if (itemIds.length > 0) {
        const { props, nodes: allNodes, stockRows } = await desk.ask('items.search.configurations', { itemIds });
      
        const nodeMap = {};
        allNodes.forEach(n => nodeMap[n.id] = n);
      
        const schemaMap = {};
        props.forEach(p => {
          if (!schemaMap[p.item_id]) schemaMap[p.item_id] = {};
          schemaMap[p.item_id][p.property_key] = p.display_name;
        });

        const configsMap = {};
        for (const id of itemIds) {
          configsMap[id] = new Map();
        }

        // Initialize with base configs to preserve order
        allNodes.forEach(n => {
          if (!n.parent_node_id) {
            configsMap[n.item_id].set(n.display_name || n.name, new Set());
          }
        });
        props.forEach(p => {
          configsMap[p.item_id].set(p.display_name, new Set());
        });

        for (const row of stockRows) {
          const itemId = row.item_id;
        
          try {
            const pathIds = row.variation_path_node_ids_json ? JSON.parse(row.variation_path_node_ids_json) : [];
            for (const id of pathIds) {
              let curr = nodeMap[id];
              let value = curr ? (curr.display_name || curr.name) : null;
              let rootName = null;
              while (curr) {
                if (!curr.parent_node_id) {
                  rootName = curr.display_name || curr.name;
                  break;
                }
                curr = nodeMap[curr.parent_node_id];
              }
              if (rootName && value) {
                if (!configsMap[itemId].has(rootName)) configsMap[itemId].set(rootName, new Set());
                configsMap[itemId].get(rootName).add(value);
              }
            }
          } catch(e) {}
        
          try {
            if (row.custom_variation_values_json) {
              const customVals = typeof row.custom_variation_values_json === 'string' ? JSON.parse(row.custom_variation_values_json) : row.custom_variation_values_json;
              if (customVals && typeof customVals === 'object' && !Array.isArray(customVals)) {
                for (const [key, val] of Object.entries(customVals)) {
                  if (!val) continue;
                  const dispName = schemaMap[itemId]?.[key] || key;
                  if (!configsMap[itemId].has(dispName)) configsMap[itemId].set(dispName, new Set());
                  configsMap[itemId].get(dispName).add(String(val));
                }
              }
            }
          } catch(e) {}
        }
      
        for (const itemId of itemIds) {
          const arr = [];
          for (const [k, vSet] of configsMap[itemId].entries()) {
            arr.push({
              name: k,
              values: Array.from(vSet)
            });
          }
          itemConfigs[itemId] = arr;
        }
      }

      const results = [
        ...items.map(item => {
          const id = String(item.id);
          const isVariation = item.variation_leaf_node_id != null;
          let label = item.display_name || item.name;
          if (isVariation && item.variation_path_label) {
            label = `${label} - ${item.variation_path_label}`;
          }
        
          const qty = isVariation ? (item.var_quantity || 0) : (item.base_quantity || 0);
        
          return {
            type: 'item',
            id: isVariation ? `${id}_${item.variation_leaf_node_id}` : id,
            label: label,
            subLabel: `Item #${item.id} • Stock: ${qty}`,
            metadata: {
              stock: qty,
              category: item.category_name || 'Item',
              baseItemId: id,
              variationId: item.variation_leaf_node_id,
              configurations: itemConfigs[item.id] || [],
            },
            score: clickMap[`item_${id}`] || 0
          };
        }),
        ...materials.map(mat => {
          return {
            type: 'material',
            id: mat.barcode,
            label: mat.name,
            subLabel: `Material (${mat.type}) • Stock: ${mat.on_hand_qty || 0}`,
            metadata: {
              stock: mat.on_hand_qty,
              category: mat.type || 'Material',
            },
            score: clickMap[`material_${mat.barcode}`] || 0
          };
        })
      ];
    
      results.sort((a, b) => b.score - a.score);
    
      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, results: [], error: error.message });
    }
  });

  app.get('/api/search/history', requirePermission('inventory.read'), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.json({ success: true, history: [] });
      }
      const history = await all(
        'SELECT query, MAX(created_at) as last_searched FROM search_history WHERE user_id = ? GROUP BY query ORDER BY last_searched DESC LIMIT 10',
        [userId]
      );
      res.json({ success: true, history: history.map(h => h.query) });
    } catch (error) {
      res.status(500).json({ success: false, history: [], error: error.message });
    }
  });

  app.post('/api/search/history', requirePermission('inventory.read'), async (req, res) => {
    try {
      const userId = req.user?.id;
      const { query } = req.body;
      if (userId && query) {
        await run(
          'INSERT INTO search_history (user_id, query, created_at) VALUES (?, ?, ?)',
          [userId, String(query).trim(), new Date().toISOString()]
        );
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/search/clicks', requirePermission('inventory.read'), async (req, res) => {
    try {
      const userId = req.user?.id;
      const { query, entityType, entityId, entityLabel } = req.body;
      if (userId && entityType && entityId) {
        await run(
          'INSERT INTO search_clicks (user_id, query, entity_type, entity_id, entity_label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, query || '', entityType, String(entityId), entityLabel || '', new Date().toISOString()]
        );
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // One code in, everything known about it out. What a scanner gun talks to.
  app.get('/api/scan/:code', requirePermission('config.read'), async (req, res) => {
    try {
      const scan = await resolveBarcode({ all, get }, req.params.code);
      res.status(scan.found ? 200 : 404).json({
        success: scan.found,
        scan,
        error: scan.found ? null : 'Nothing here carries that code.',
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        scan: null,
        error: error.message,
      });
    }
  });

  app.get('/api/barcode/lookup', requirePermission('config.read'), async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) {
        return res.status(400).json({ success: false, error: 'Code is required' });
      }
    
      const { row } = await desk.ask('challans.pieceBarcodes.lookup', { code });
    
      if (row) {
        const itemDesc = await itemsPorts.describe(row.item_id);
        row.item_name = itemDesc?.name || 'Unknown Item';
        row.short_code = itemDesc?.shortCode || '';
        // The piece-barcode shape the existing client already reads, kept as it
        // was, plus the universal envelope beside it.
        const universal = await resolveBarcode({ all, get }, code);
        return res.json({ success: true, result: row, scan: universal });
      }

      // Everything that is not a piece barcode.
      //
      // This endpoint used to end here with a 404 — which is why scanning a sheet
      // you were holding said "Barcode not found in database.", the identical
      // answer it gave to a code that never existed. It searched `piece_barcodes`
      // and nothing else, so a real `materials.barcode` was indistinguishable
      // from nonsense.
      const universal = await resolveBarcode({ all, get }, code);
      if (!universal.found) {
        return res.status(404).json({
          success: false,
          error: universal.resolution.looksLikeOurs
            ? 'That is one of ours, but it names nothing here — it may belong to another workspace, or the record may have been deleted.'
            : 'Barcode not found in database.',
          scan: universal,
        });
      }
      res.json({ success: true, result: null, scan: universal });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerSearchRoutes,
};
