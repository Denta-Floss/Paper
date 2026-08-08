'use strict';

// ---------------------------------------------------------------------------
// Mobile module — HTTP routes.
//
// All 4 route registrations for mobile territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order matches
// server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerMobileModuleRoutes(ctx) {
  const {
    app,
    requireAuth,
    getIo,
    changeEmitter,
  } = ctx;

app.post('/api/mobile/stage-item', requireAuth, async (req, res) => {
  try {
    const io = getIo ? getIo() : null;
    if (io) io.emit('item_staged', req.body);
    if (changeEmitter) changeEmitter.emit('custom-event', { event: 'item_staged', data: req.body });
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/mobile/remove-staged-item', requireAuth, async (req, res) => {
  try {
    const io = getIo ? getIo() : null;
    if (io) io.emit('item_removed', req.body);
    if (changeEmitter) changeEmitter.emit('custom-event', { event: 'item_removed', data: req.body });
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/mobile/lock-inventory', requireAuth, async (req, res) => {
  try {
    const io = getIo ? getIo() : null;
    if (io) io.emit('inventory_locked', req.body);
    if (changeEmitter) changeEmitter.emit('custom-event', { event: 'inventory_locked', data: req.body });
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/mobile/challan-generated', requireAuth, async (req, res) => {
  try {
    const io = getIo ? getIo() : null;
    if (io) io.emit('challan_generated_ok', req.body);
    if (changeEmitter) changeEmitter.emit('custom-event', { event: 'challan_generated_ok', data: req.body });
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
