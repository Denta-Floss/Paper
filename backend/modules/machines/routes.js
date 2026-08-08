'use strict';

// ---------------------------------------------------------------------------
// Machines module — HTTP routes.
//
// All 7 route registrations for machines territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerMachinesModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    machineRowToDto,
    trackCreate,
    trackUpdate,
    trackDelete,
    listAssetsForEntity,
    createAssetUploadIntent,
    completeAssetUpload,
    isMachineAssignedToActiveRun,
  } = ctx;

app.get('/api/machines', requirePermission('config.read'), async (req, res) => {
  try {
    const rows = await all('SELECT * FROM machines ORDER BY created_at DESC');
    const machines = rows.map(machineRowToDto);
    res.json({ success: true, machines, error: null });
  } catch (error) {
    res.status(500).json({ success: false, machines: [], error: error.message });
  }
});

app.get('/api/machines/:id', requirePermission('config.read'), async (req, res) => {
  try {
    const r = await get('SELECT * FROM machines WHERE id = ?', [req.params.id]);
    if (!r) {
      return res.status(404).json({ success: false, machine: null, error: 'Machine not found' });
    }
    const machine = machineRowToDto(r);
    res.json({ success: true, machine, error: null });
  } catch (error) {
    res.status(500).json({ success: false, machine: null, error: error.message });
  }
});

app.post('/api/machines', requirePermission('config.write'), async (req, res) => {
  try {
    const {
      id,
      name,
      assetId,
      primaryPhotoUrl,
      groupId,
      makeModel,
      serialNumber,
      location,
      installationDate,
      status,
      reportOutputPerHour,
      setupMinutes,
      laborCount,
      powerKw,
      reportNotes,
      customProperties,
    } = req.body || {};
    const now = new Date().toISOString();
    let finalAssetId = assetId;
    if (!finalAssetId || finalAssetId.trim() === '') {
      finalAssetId = `MACH-${Date.now()}`;
    }
    let resultId = id;
    let beforeRow = null;
    const isUpdate = id && id.trim() !== '' && !id.startsWith('temp_') && isNaN(Number(id)) === false;
    if (isUpdate) {
      // Update
      beforeRow = await get('SELECT * FROM machines WHERE id = ?', [Number(id)]);
      await run(
        `UPDATE machines SET name = ?, asset_id = ?, primary_photo_url = ?, group_id = ?, make_model = ?, serial_number = ?, location = ?, installation_date = ?, status = ?, report_output_per_hour = ?, setup_minutes = ?, labor_count = ?, power_kw = ?, report_notes = ?, custom_properties = ?, updated_at = ? WHERE id = ?`,
        [name, finalAssetId, primaryPhotoUrl, groupId, makeModel, serialNumber, location, installationDate, status, reportOutputPerHour ?? null, setupMinutes ?? null, laborCount ?? null, powerKw ?? null, reportNotes || '', JSON.stringify(customProperties || []), now, Number(id)]
      );
    } else {
      // Create
      const info = await run(
        `INSERT INTO machines (name, asset_id, primary_photo_url, group_id, make_model, serial_number, location, installation_date, status, report_output_per_hour, setup_minutes, labor_count, power_kw, report_notes, custom_properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, finalAssetId, primaryPhotoUrl, groupId, makeModel, serialNumber, location, installationDate, status, reportOutputPerHour ?? null, setupMinutes ?? null, laborCount ?? null, powerKw ?? null, reportNotes || '', JSON.stringify(customProperties || []), now, now]
      );
      resultId = String(info.lastID);
    }
    const r = await get('SELECT * FROM machines WHERE id = ?', [resultId]);
    const machine = machineRowToDto(r);
    if (isUpdate) {
      trackUpdate('machines', resultId, beforeRow, r, req);
    } else {
      trackCreate('machines', resultId, r, req);
    }
    res.json({ success: true, machine, error: null });
  } catch (error) {
    res.status(500).json({ success: false, machine: null, error: error.message });
  }
});

app.delete('/api/machines/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = req.params.id;
    const isAssigned = await isMachineAssignedToActiveRun(id);
    if (isAssigned) {
      return res.status(400).json({ success: false, error: 'Cannot delete machine: assigned to an active pipeline run.' });
    }
    const before = await get('SELECT * FROM machines WHERE id = ?', [id]);
    await run('DELETE FROM machines WHERE id = ?', [id]);
    trackDelete('machines', id, before, req);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Machines Assets
app.get('/api/machines/:id/assets', requirePermission('config.read'), async (req, res) => {
  try {
    const assets = await listAssetsForEntity('machine', Number(req.params.id));
    res.json({ success: true, assets, error: null });
  } catch (error) {
    res.status(500).json({ success: false, assets: [], error: error.message });
  }
});

app.post('/api/machines/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
  try {
    const entityId = Number(req.params.id);
    const intent = await createAssetUploadIntent({
      ...(req.body || {}),
      entityType: 'machine',
      entityId,
    });
    res.status(intent.alreadyUploaded ? 200 : 201).json({ success: true, intent, error: null });
  } catch (error) {
    res.status(500).json({ success: false, intent: null, error: error.message });
  }
});

app.post('/api/machines/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
  try {
    const asset = await completeAssetUpload(req.body || {});
    res.json({ success: true, asset, error: null });
  } catch (error) {
    res.status(500).json({ success: false, asset: null, error: error.message });
  }
});

};
