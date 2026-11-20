'use strict';

// ---------------------------------------------------------------------------
// Inventory's work behind its routes: sets, materials, stock and movements.
//
// These were the bodies of the twenty-two handlers in routes.js, here statement
// for statement. Instead of writing a response each returns answer(status,
// body), the same status and the same body; and where one wrote a Track entry
// it notes it on the request (req.track), because Track needs the real request
// and the route writes it. A function takes a plain `req` with `params`,
// `query`, `body` and `user`.
//
// ./operations.js publishes them at the kernel desk; ./routes.js asks the desk.
// The service these call is ./service.js, as before.
// ---------------------------------------------------------------------------

const { answer } = require('../../kernel/desk-kit');

function createInventoryWork({
  get,
  run,
  all,
  currentActor,
  inventory,
  // Still defined in server.js: the barcode lookup items and inventory share.
  getMaterialRowByBarcode,
}) {

  async function listSets(req) {
    try {
      const sets = await inventory.getInventorySets();
      return answer(200, { success: true, sets, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        sets: [],
        error: error.message,
        code: error.code ?? null,
      });
    }
  }

  async function createSet(req) {
    try {
      const set = await inventory.saveInventorySet(req.body || {});
      req.track('create', 'inventory_sets', set.id, set);
      return answer(201, { success: true, set, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  }

  async function updateSet(req) {
    try {
      const id = Number(req.params.id);
      // saveInventorySet answers with the DTO, not the row it replaced, so the
      // before state has to be read here or the diff would be empty and
      // trackUpdate would log nothing at all.
      const before = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      const set = await inventory.saveInventorySet({
        ...(req.body || {}),
        id,
      });
      const after = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      req.track('update', 'inventory_sets', id, before, after);
      return answer(200, { success: true, set, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  }

  async function deleteSet(req) {
    try {
      const id = Number(req.params.id);
      // Deleting a set is permanent — it purges links and drops the row with no
      // trashAndDelete — so this log line is the only surviving record of it.
      const before = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      await inventory.deleteInventorySet(id);
      req.track('delete', 'inventory_sets', id, before);
      return answer(200, { success: true, set: null, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  }

  async function stock(req) {
    try {
      return answer(200, { success: true, stock: await inventory.getStockOverview() });
    } catch (error) {
      return answer(500, { success: false, stock: [], error: error.message });
    }
  }

  // The barcodes a quantity of one item and variation can come from, by name,
  // with what each has free and a proposal (oldest first) for `quantity`.
  async function stockSources(req) {
    try {
      const itemId = Number(req.query.itemId || 0);
      if (!(itemId > 0)) {
        return answer(400, { success: false, sources: [], error: 'itemId is required.' });
        return;
      }
      const sources = await inventory.stockSourcesForItem(itemId, Number(req.query.variationLeafNodeId || 0));
      const quantity = Number(req.query.quantity || 0);
      return answer(200, {
        success: true,
        sources,
        totalFree: sources.reduce((sum, source) => sum + source.free, 0),
        proposal: quantity > 0 ? inventory.proposeStockAllocation(sources, quantity) : [],
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, sources: [], error: error.message });
    }
  }

  async function listMaterials(req) {
    try {
      const rows = await all(
        // A material whose reception was cancelled is kept for the trail only.
        "SELECT * FROM materials WHERE COALESCE(inventory_state, '') != 'cancelled' ORDER BY kind ASC, created_at DESC, barcode ASC",
      );
      return answer(200, { success: true, materials: rows.map(inventory.rowToMaterialDto) });
    } catch (error) {
      return answer(500, { success: false, materials: [], error: error.message });
    }
  }

  // The inventory screen's four reads in one answer: materials, stock by item
  // and variation, sets and the summary tiles. Each part is exactly what its
  // own endpoint answers, so a client can switch without a second parser.
  //
  // `?materials=0` leaves the materials out, for a client that already reads
  // them from its replica: it still costs one request, and not the largest
  // part of it.
  //
  // The tiles are an estimate a client can make for itself, so a failure there
  // is reported (`healthError`) and does not fail the answer; any other part
  // failing does.
  async function overview(req) {
    const withMaterials = String(req.query?.materials ?? '1') !== '0';
    const [materials, stockAnswer, setsAnswer, healthAnswer] = await Promise.all([
      withMaterials ? listMaterials(req) : null,
      stock(req),
      listSets(req),
      health(req),
    ]);
    const failed = [materials, stockAnswer, setsAnswer].find((part) => part && part.status >= 400);
    if (failed) {
      return answer(failed.status, {
        success: false,
        error: failed.body.error || 'Failed to load inventory.',
        code: failed.body.code ?? null,
      });
    }
    return answer(200, {
      success: true,
      ...(materials ? { materials: materials.body.materials } : {}),
      stock: stockAnswer.body.stock,
      sets: setsAnswer.body.sets,
      health: healthAnswer.status < 400 ? healthAnswer.body.health : null,
      healthError: healthAnswer.status < 400 ? null : healthAnswer.body.error,
      error: null,
    });
  }

  async function health(req) {
    try {
      const health = await inventory.getInventoryHealthSummary();
      return answer(200, { success: true, health, error: null });
    } catch (error) {
      return answer(500, {
        success: false,
        health: null,
        error: error.message,
      });
    }
  }

  async function getMaterial(req) {
    try {
      const row = await getMaterialRowByBarcode(req.params.barcode);
      if (!row) {
        return answer(404, {
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      const groupConfiguration = await inventory.getMaterialGroupGovernance(row.id);
      return answer(200, {
        success: true,
        material: inventory.rowToMaterialDto(row),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function materialDetail(req) {
    try {
      const detail = await inventory.getMaterialControlTowerDetail(req.params.barcode);
      if (!detail) {
        return answer(404, {
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      const row = await getMaterialRowByBarcode(req.params.barcode);
      const groupConfiguration = row
        ? await inventory.getMaterialGroupGovernance(row.id)
        : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
      return answer(200, {
        success: true,
        ...detail,
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      return answer(500, {
        success: false,
        material: null,
        error: error.message,
      });
    }
  }

  async function createParent(req) {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!payload.name || !payload.type || payload.numberOfChildren == null) {
        return answer(400, {
          success: false,
          material: null,
          error: 'name, type, and numberOfChildren are required.',
        });
        return;
      }

      const material = await inventory.createParentWithChildren(payload);
      const createdRow = await getMaterialRowByBarcode(material.barcode);
      const groupConfiguration = createdRow
        ? await inventory.getMaterialGroupGovernance(createdRow.id)
        : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
      // Materials also keep their own `material_activity` feed, read by
      // GET /api/materials/:barcode/activity. That one is per-barcode stock
      // movement; this is who-changed-what, which is the axis a sitting groups
      // by — so both are wanted, and neither replaces the other.
      if (createdRow) req.track('create', 'materials', createdRow.id, createdRow);
      return answer(201, { success: true, material, groupConfiguration, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function createChild(req) {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!String(payload.name || '').trim()) {
        return answer(400, {
          success: false,
          material: null,
          error: 'name is required.',
        });
        return;
      }
      const material = await inventory.createChildMaterial(req.params.barcode, payload);
      req.track('create', 'materials', material.id, material);
      return answer(201, { success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function updateMaterial(req) {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!payload.name || !payload.type) {
        return answer(400, {
          success: false,
          material: null,
          error: 'name and type are required.',
        });
        return;
      }
      const before = await getMaterialRowByBarcode(req.params.barcode);
      const material = await inventory.updateMaterialRecord(req.params.barcode, payload);
      const groupConfiguration = await inventory.getMaterialGroupGovernance(material.id);
      req.track('update', 'materials', material.id, before, material);
      return answer(200, {
        success: true,
        material: inventory.rowToMaterialDto(material),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      return answer(500, { success: false, material: null, error: error.message });
    }
  }

  async function setGroupConfig(req) {
    try {
      const payload = req.body || {};
      const material = await inventory.updateMaterialGroupConfiguration(req.params.barcode, payload);
      const groupConfiguration = await inventory.getMaterialGroupGovernance(material.id);
      return answer(200, {
        success: true,
        material: inventory.rowToMaterialDto(material),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      return answer(500, { success: false, material: null, error: error.message });
    }
  }

  async function deleteMaterial(req) {
    try {
      // The barcode is the handle here, not the id, so the row has to be read
      // before it goes to have anything to log against.
      const before = await getMaterialRowByBarcode(req.params.barcode);
      await inventory.deleteMaterialRecord(req.params.barcode);
      if (before) req.track('delete', 'materials', before.id, before);
      return answer(200, { success: true, material: null, error: null });
    } catch (error) {
      return answer(500, { success: false, material: null, error: error.message });
    }
  }

  async function linkGroup(req) {
    try {
      const material = await inventory.linkMaterialRecordToGroup(
        req.params.barcode,
        req.body?.groupId,
      );
      return answer(200, { success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function linkItem(req) {
    try {
      const material = await inventory.linkMaterialRecordToItem(
        req.params.barcode,
        req.body?.itemId,
        req.body?.variationLeafNodeId,
      );
      return answer(200, { success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function unlink(req) {
    try {
      const material = await inventory.unlinkMaterialRecord(req.params.barcode);
      return answer(200, { success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, material: null, error: error.message });
    }
  }

  async function scan(req) {
    try {
      const materialRow = await inventory.incrementMaterialScanCount(req.params.barcode);
      if (!materialRow) {
        return answer(404, {
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      return answer(200, {
        success: true,
        material: inventory.rowToMaterialDto(materialRow),
        error: null,
      });
    } catch (error) {
      return answer(500, { success: false, material: null, error: error.message });
    }
  }

  async function resetScan(req) {
    try {
      const row = await getMaterialRowByBarcode(req.params.barcode);
      if (!row) {
        return answer(404, {
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      await run(
        'UPDATE materials SET scan_count = 0, updated_at = ?, last_scanned_at = NULL WHERE id = ?',
        [new Date().toISOString(), row.id],
      );
      await run('DELETE FROM scan_history WHERE barcode = ?', [row.barcode]);
      await inventory.logMaterialActivity({
        barcode: row.barcode,
        type: 'scanReset',
        label: 'Trace reset',
        description: 'Scan history was cleared for this material.',
        actor: row.created_by || 'Demo Admin',
      });
      const updatedRow = await get('SELECT * FROM materials WHERE id = ?', [row.id]);
      return answer(200, {
        success: true,
        material: inventory.rowToMaterialDto(updatedRow),
        error: null,
      });
    } catch (error) {
      return answer(500, { success: false, material: null, error: error.message });
    }
  }

  async function applyMovement(req) {
    try {
      const detail = await inventory.applyInventoryMovement({
        ...(req.body || {}),
        actor: currentActor(req),
      });
      return answer(201, {
        success: true,
        ...detail,
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        material: null,
        error: error.message,
      });
    }
  }

  async function activity(req) {
    try {
      const events = await inventory.getMaterialActivity(req.params.barcode);
      return answer(200, {
        success: true,
        events: events.map(inventory.rowToMaterialActivityDto),
        error: null,
      });
    } catch (error) {
      return answer(500, { success: false, events: [], error: error.message });
    }
  }

  return {
    listSets,
    createSet,
    updateSet,
    deleteSet,
    stock,
    stockSources,
    listMaterials,
    overview,
    health,
    getMaterial,
    materialDetail,
    createParent,
    createChild,
    updateMaterial,
    setGroupConfig,
    deleteMaterial,
    linkGroup,
    linkItem,
    unlink,
    scan,
    resetScan,
    applyMovement,
    activity,
  };
}

module.exports = { createInventoryWork };
