'use strict';

// ---------------------------------------------------------------------------
// Challan templates over HTTP.
//
//   GET    /api/challan-templates                        the templates
//   GET    /api/challan-templates/scans                  uploaded form scans
//   GET    /api/challan-templates/:id                    one
//   POST   /api/challan-templates                        create
//   PATCH  /api/challan-templates/:id                    change
//   DELETE /api/challan-templates/:id                    remove
//   POST   /api/challan-templates/upload-intent          scan upload, start
//   POST   /api/challan-templates/upload-complete        scan upload, finish
//   POST   /api/challan-templates/stamp-upload-intent    stamp upload, start
//   POST   /api/challan-templates/stamp-upload-complete  stamp upload, finish
//   POST   /api/challan-templates/test-print             a sample PDF
//   GET    /api/templates/:id/test-print                 a sample PDF, by id
//   GET    /api/challans/:id/print-template-preview      a challan on its template
//
// ORDER MATTERS in this file: /scans and POST /test-print are registered before
// /:id. The route-surface test sorts its list and cannot see an order change;
// challans-routes.test.js pins /scans answering 200 for that reason.
//
// KNOWN BUG, kept: GET /api/challan-templates/test-print is registered after
// GET /:id, which answers it as a 404 ("test-print" read as an id). Nothing
// calls it; the app uses the POST and the /api/templates/:id form.
//
// Handlers are the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------

module.exports = function registerChallanTemplateRoutes(ctx) {
  const {
    templateService,
    app,
    requirePermission,
    parseBooleanEnv,
    parseJsonObject,
    getDeliveryChallanRowById,
  } = ctx;

  app.get('/api/challan-templates', requirePermission('config.read'), async (req, res) => {
    try {
      const templates = await templateService.listChallanTemplates({
        partyType: req.query.partyType || req.query.party_type || '',
        partyId: req.query.partyId || req.query.party_id,
        challanType: req.query.challanType || req.query.challan_type || '',
        activeOnly: parseBooleanEnv(req.query.activeOnly || req.query.active_only, false),
      });
      res.json({ success: true, templates, data: templates, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        templates: [],
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/challan-templates/scans', requirePermission('config.read'), async (req, res) => {
    try {
      const scans = await templateService.listChallanTemplateScans({
        limit: req.query.limit,
      });
      res.json({ success: true, scans, data: scans, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        scans: [],
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  });

  app.get('/api/challan-templates/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const template = await templateService.getChallanTemplateRowById(Number(req.params.id));
      if (!template) {
        res.status(404).json({
          success: false,
          template: null,
          data: null,
          message: 'Challan template not found.',
          error: 'Challan template not found.',
        });
        return;
      }
      const dto = await templateService.rowToChallanTemplateDto(template);
      res.json({ success: true, template: dto, data: dto, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.post('/api/challan-templates', requirePermission('config.write'), async (req, res) => {
    try {
      const template = await templateService.saveChallanTemplate(req.body || {});
      res.status(201).json({ success: true, template, data: template, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.patch('/api/challan-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const template = await templateService.saveChallanTemplate(req.body || {}, Number(req.params.id));
      res.json({ success: true, template, data: template, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.delete('/api/challan-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      await templateService.deleteChallanTemplate(Number(req.params.id));
      res.json({ success: true, data: null, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.post('/api/challan-templates/upload-intent', requirePermission('config.write'), async (req, res) => {
    try {
      const upload = await templateService.createChallanTemplateUploadIntent({
        ...(req.body || {}),
        uploadType: 'CHALLAN_TEMPLATE_BACKGROUND',
      });
      res.status(201).json({ success: true, upload, data: upload, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        upload: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.post('/api/challan-templates/upload-complete', requirePermission('config.write'), async (req, res) => {
    try {
      const background = await templateService.completeChallanTemplateUpload(req.body || {});
      res.json({ success: true, background, data: background, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        background: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.post('/api/challan-templates/stamp-upload-intent', requirePermission('config.write'), async (req, res) => {
    try {
      const upload = await templateService.createChallanTemplateUploadIntent({
        ...(req.body || {}),
        uploadType: 'CHALLAN_TEMPLATE_STAMP',
      });
      res.status(201).json({ success: true, upload, data: upload, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        upload: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  app.post('/api/challan-templates/stamp-upload-complete', requirePermission('config.write'), async (req, res) => {
    try {
      const stamp = await templateService.completeChallanTemplateUpload(req.body || {});
      res.json({ success: true, stamp, data: stamp, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        stamp: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

  async function handleChallanTemplateTestPrint(req, res) {
    try {
      const templateId = Number(
          req.body?.templateId ||
          req.body?.template_id ||
          req.query.templateId ||
          req.query.template_id ||
          req.params?.id ||
          0,
      );
      if (!templateId) {
        res.status(400).json({
          success: false,
          message: 'Template id is required.',
          error: 'Template id is required.',
        });
        return;
      }
      const itemCount = Number(
        req.body?.itemCount ||
          req.body?.item_count ||
          req.query.itemCount ||
          req.query.item_count ||
          3,
      );
      const template = await templateService.getChallanTemplateRowById(templateId);
      if (!template) {
        res.status(404).json({
          success: false,
          message: 'Challan template not found.',
          error: 'Challan template not found.',
        });
        return;
      }
      const mappingOverride = Array.isArray(req.body?.mappings)
        ? req.body.mappings
        : null;
      const templateSnapshot = mappingOverride
        ? {
            ...(await templateService.rowToChallanTemplateDto(template)),
            mappings: mappingOverride,
          }
        : null;
      const buffer = await templateService.generateChallanTemplatePdf({
        challanRow: null,
        challanDtoOverride: templateService.buildTemplateTestChallanDto(itemCount),
        templateRow: templateSnapshot ? null : template,
        templateSnapshot,
        mode: req.body?.mode || req.query.mode,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="challan-template-test-${templateId}.pdf"`,
      );
      res.send(buffer);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  }

  app.post('/api/challan-templates/test-print', requirePermission('config.read'), async (req, res) => {
    await handleChallanTemplateTestPrint(req, res);
  });

  app.get('/api/challan-templates/test-print', requirePermission('config.read'), async (req, res) => {
    await handleChallanTemplateTestPrint(req, res);
  });

  app.get('/api/templates/:id/test-print', requirePermission('config.read'), async (req, res) => {
    await handleChallanTemplateTestPrint(req, res);
  });

  app.get('/api/challans/:id/print-template-preview', requirePermission('config.read'), async (req, res) => {
    try {
      const challan = await getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        res.status(404).json({
          success: false,
          message: 'Challan not found.',
          error: 'Challan not found.',
        });
        return;
      }
      const snapshot = parseJsonObject(challan.template_snapshot_json, null);
      const useSnapshot = challan.status !== 'draft' && snapshot;
      const templateId = Number(req.query.templateId || req.query.template_id || 0);
      const template = useSnapshot
        ? null
        : templateId > 0
        ? await templateService.getChallanTemplateRowById(templateId)
        : await templateService.findActiveChallanTemplateForChallan(challan);
      if (!useSnapshot && !template) {
        res.status(404).json({
          success: false,
          message: 'Matching challan template not found.',
          error: 'Matching challan template not found.',
        });
        return;
      }
      const buffer = await templateService.generateChallanTemplatePdf({
        challanRow: challan,
        templateRow: template,
        templateSnapshot: useSnapshot ? snapshot : null,
        mode: req.query.mode,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${String(challan.challan_no || 'challan').replace(/[^a-zA-Z0-9_.-]/g, '_')}-${String(req.query.mode || 'digital')}.pdf"`,
      );
      res.send(buffer);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  });
};
