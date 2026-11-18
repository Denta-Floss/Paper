'use strict';

// ---------------------------------------------------------------------------
// Challan print templates: the master, its scans and stamps, test prints and a challan’s print preview.
//
// These were the bodies of the handlers in template-routes.js, here statement for
// statement. Instead of writing a response each returns answer(status, body)
// (or answerFile for a PDF): the same status, the same body. A function takes a
// plain `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes them at the kernel desk; ./template-routes.js asks the
// desk and sends the result back as the answer it was.
// ---------------------------------------------------------------------------

const { answer, answerFile } = require('../../kernel/desk-kit');

function createChallanTemplateWork({
  templateService,
  parseBooleanEnv,
  parseJsonObject,
  getDeliveryChallanRowById,
}) {

  async function listTemplates(req) {
    try {
      const templates = await templateService.listChallanTemplates({
        partyType: req.query.partyType || req.query.party_type || '',
        partyId: req.query.partyId || req.query.party_id,
        challanType: req.query.challanType || req.query.challan_type || '',
        activeOnly: parseBooleanEnv(req.query.activeOnly || req.query.active_only, false),
      });
      return answer(200, { success: true, templates, data: templates, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        templates: [],
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  async function listTemplateScans(req) {
    try {
      const scans = await templateService.listChallanTemplateScans({
        limit: req.query.limit,
      });
      return answer(200, { success: true, scans, data: scans, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        scans: [],
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  // Ahead of /:id, like /scans: registered after it, "test-print" was read as
  // a template id and answered 404.
  async function testPrintGet(req) {
    return handleChallanTemplateTestPrint(req);
  }

  async function getTemplate(req) {
    try {
      const template = await templateService.getChallanTemplateRowById(Number(req.params.id));
      if (!template) {
        return answer(404, {
          success: false,
          template: null,
          data: null,
          message: 'Challan template not found.',
          error: 'Challan template not found.',
        });
        return;
      }
      const dto = await templateService.rowToChallanTemplateDto(template);
      return answer(200, { success: true, template: dto, data: dto, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function createTemplate(req) {
    try {
      const template = await templateService.saveChallanTemplate(req.body || {});
      return answer(201, { success: true, template, data: template, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function updateTemplate(req) {
    try {
      const template = await templateService.saveChallanTemplate(req.body || {}, Number(req.params.id));
      return answer(200, { success: true, template, data: template, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        template: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function deleteTemplate(req) {
    try {
      await templateService.deleteChallanTemplate(Number(req.params.id));
      return answer(200, { success: true, data: null, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function templateUploadIntent(req) {
    try {
      const upload = await templateService.createChallanTemplateUploadIntent({
        ...(req.body || {}),
        uploadType: 'CHALLAN_TEMPLATE_BACKGROUND',
      });
      return answer(201, { success: true, upload, data: upload, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        upload: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function templateUploadComplete(req) {
    try {
      const background = await templateService.completeChallanTemplateUpload(req.body || {});
      return answer(200, { success: true, background, data: background, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        background: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function stampUploadIntent(req) {
    try {
      const upload = await templateService.createChallanTemplateUploadIntent({
        ...(req.body || {}),
        uploadType: 'CHALLAN_TEMPLATE_STAMP',
      });
      return answer(201, { success: true, upload, data: upload, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        upload: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function stampUploadComplete(req) {
    try {
      const stamp = await templateService.completeChallanTemplateUpload(req.body || {});
      return answer(200, { success: true, stamp, data: stamp, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        stamp: null,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function handleChallanTemplateTestPrint(req) {
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
        return answer(400, {
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
        return answer(404, {
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
      return answerFile('application/pdf', `inline; filename="challan-template-test-${templateId}.pdf"`, buffer);
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function testPrintPost(req) {
    return handleChallanTemplateTestPrint(req);
  }

  async function testPrintForTemplate(req) {
    return handleChallanTemplateTestPrint(req);
  }

  async function printTemplatePreview(req) {
    try {
      const challan = await getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        return answer(404, {
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
        return answer(404, {
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
      return answerFile('application/pdf', `inline; filename="${String(challan.challan_no || 'challan').replace(/[^a-zA-Z0-9_.-]/g, '_')}-${String(req.query.mode || 'digital')}.pdf"`, buffer);
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        message: error.message,
        error: error.message,
      });
    }
  }

  return {
    listTemplates,
    listTemplateScans,
    testPrintGet,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    templateUploadIntent,
    templateUploadComplete,
    stampUploadIntent,
    stampUploadComplete,
    testPrintPost,
    testPrintForTemplate,
    printTemplatePreview,
  };
}

module.exports = { createChallanTemplateWork };
