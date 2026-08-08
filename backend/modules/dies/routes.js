'use strict';

// ---------------------------------------------------------------------------
// Dies module — HTTP routes.
//
// All 7 route registrations for dies territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerDiesModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    dieRowToDto,
    trackCreate,
    trackUpdate,
    trackDelete,
    listAssetsForEntity,
    createAssetUploadIntent,
    completeAssetUpload,
    isDieAssignedToActiveRun,
  } = ctx;

app.get('/api/dies', requirePermission('config.read'), async (req, res) => {
  try {
    const rows = await all('SELECT * FROM dies ORDER BY created_at DESC');
    const dies = rows.map(dieRowToDto);
    res.json({ success: true, dies, error: null });
  } catch (error) {
    res.status(500).json({ success: false, dies: [], error: error.message });
  }
});

app.get('/api/dies/:id', requirePermission('config.read'), async (req, res) => {
  try {
    const r = await get('SELECT * FROM dies WHERE id = ?', [req.params.id]);
    if (!r) {
      return res.status(404).json({ success: false, die: null, error: 'Die not found' });
    }
    const die = dieRowToDto(r);
    res.json({ success: true, die, error: null });
  } catch (error) {
    res.status(500).json({ success: false, die: null, error: error.message });
  }
});

app.post('/api/dies', requirePermission('config.write'), async (req, res) => {
  try {
    const {
      id,
      toolCode,
      producedPartNumbers,
      photoUrls,
      operationalNotes,
      compatibleMachineGroupIds,
      storageLocation,
      numberOfCavities,
      strokeCount,
      maxStrokes,
      strokesPerPiece,
      setupMinutes,
      reportNotes,
      physicalSpecs,
      status,
      ownership,
    } = req.body || {};
    const now = new Date().toISOString();
    let finalToolCode = toolCode;
    if (!finalToolCode || finalToolCode.trim() === '') {
      finalToolCode = `DIE-${Date.now()}`;
    }
    let resultId = id;
    let beforeRow = null;
    const isUpdate = id && id.trim() !== '' && !id.startsWith('temp_') && isNaN(Number(id)) === false;
    if (isUpdate) {
      // Update
      beforeRow = await get('SELECT * FROM dies WHERE id = ?', [Number(id)]);
      await run(
        `UPDATE dies SET tool_code = ?, produced_part_numbers = ?, photo_urls = ?, operational_notes = ?, compatible_machine_group_ids = ?, storage_location = ?, number_of_cavities = ?, stroke_count = ?, max_strokes = ?, strokes_per_piece = ?, setup_minutes = ?, report_notes = ?, physical_specs = ?, status = ?, ownership = ?, updated_at = ? WHERE id = ?`,
        [finalToolCode, JSON.stringify(producedPartNumbers || []), JSON.stringify(photoUrls || []), operationalNotes, JSON.stringify(compatibleMachineGroupIds || []), storageLocation, numberOfCavities, strokeCount || 0, maxStrokes || 0, strokesPerPiece ?? null, setupMinutes ?? null, reportNotes || '', JSON.stringify(physicalSpecs || {}), status, ownership, now, Number(id)]
      );
    } else {
      // Create
      const info = await run(
        `INSERT INTO dies (tool_code, produced_part_numbers, photo_urls, operational_notes, compatible_machine_group_ids, storage_location, number_of_cavities, stroke_count, max_strokes, strokes_per_piece, setup_minutes, report_notes, physical_specs, status, ownership, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [finalToolCode, JSON.stringify(producedPartNumbers || []), JSON.stringify(photoUrls || []), operationalNotes, JSON.stringify(compatibleMachineGroupIds || []), storageLocation, numberOfCavities, strokeCount || 0, maxStrokes || 0, strokesPerPiece ?? null, setupMinutes ?? null, reportNotes || '', JSON.stringify(physicalSpecs || {}), status, ownership, now, now]
      );
      resultId = String(info.lastID);
    }
    const r = await get('SELECT * FROM dies WHERE id = ?', [resultId]);
    const die = dieRowToDto(r);
    if (isUpdate) {
      trackUpdate('dies', resultId, beforeRow, r, req);
    } else {
      trackCreate('dies', resultId, r, req);
    }
    res.json({ success: true, die, error: null });
  } catch (error) {
    res.status(500).json({ success: false, die: null, error: error.message });
  }
});

app.delete('/api/dies/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = req.params.id;
    const isAssigned = await isDieAssignedToActiveRun(id);
    if (isAssigned) {
      return res.status(400).json({ success: false, error: 'Cannot delete die: assigned to an active pipeline run.' });
    }
    const before = await get('SELECT * FROM dies WHERE id = ?', [id]);
    await run('DELETE FROM dies WHERE id = ?', [id]);
    trackDelete('dies', id, before, req);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dies Assets
app.get('/api/dies/:id/assets', requirePermission('config.read'), async (req, res) => {
  try {
    const assets = await listAssetsForEntity('die', Number(req.params.id));
    res.json({ success: true, assets, error: null });
  } catch (error) {
    res.status(500).json({ success: false, assets: [], error: error.message });
  }
});

app.post('/api/dies/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
  try {
    const entityId = Number(req.params.id);
    const intent = await createAssetUploadIntent({
      ...(req.body || {}),
      entityType: 'die',
      entityId,
    });
    res.status(intent.alreadyUploaded ? 200 : 201).json({ success: true, intent, error: null });
  } catch (error) {
    res.status(500).json({ success: false, intent: null, error: error.message });
  }
});

app.post('/api/dies/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
  try {
    const asset = await completeAssetUpload(req.body || {});
    res.json({ success: true, asset, error: null });
  } catch (error) {
    res.status(500).json({ success: false, asset: null, error: error.message });
  }
});

};
