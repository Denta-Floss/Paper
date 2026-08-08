'use strict';

// ---------------------------------------------------------------------------
// Company Profile module — HTTP routes.
//
// All 2 route registrations for company-profile territory moved VERBATIM from
// server.js. No logic edits; handler bodies are NOT re-indented. Registration
// order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerCompanyProfileModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    getActiveCompanyProfile,
    saveCompanyProfile,
    rowToCompanyProfileDto,
  } = ctx;

app.get('/api/company-profile', requirePermission('config.read'), async (_req, res) => {
  try {
    const profile = await getActiveCompanyProfile();
    res.json({ success: true, data: rowToCompanyProfileDto(profile), error: null });
  } catch (error) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
});

app.put('/api/company-profile', requirePermission('config.write'), async (req, res) => {
  try {
    const profile = await saveCompanyProfile(req.body || {});
    res.json({ success: true, data: rowToCompanyProfileDto(profile), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: null,
      error: error.message,
    });
  }
});

};
