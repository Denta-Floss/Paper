'use strict';

// ---------------------------------------------------------------------------
// Kernel Asset & Upload routes.
//
// Presigned URLs, upload session handling, deletion, S3 integration.
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');

module.exports = function registerAssetsKernelRoutes(ctx) {
  const {
    app,
    requirePermission,
    requireGenericUploadPermission,
    requireAssetEntityPermission,
    assetEntityTypeFromBody,
    assetEntityTypeFromUploadSession,
    assetEntityTypeFromAssetId,
    normalizeAssetFileName,
    presignS3Url,
    createAssetUploadIntent,
    completeAssetUpload,
    createAssetReadUrl,
    setPrimaryAsset,
    deleteAsset,
    getS3Client,
    run,
  } = ctx;

app.post('/api/upload/generic', requireGenericUploadPermission, async (req, res) => {
  try {
    const { fileName, contentType, sha256 } = req.body || {};
    if (!fileName || !contentType) {
      const error = new Error('fileName and contentType are required.');
      error.statusCode = 400;
      throw error;
    }
    
    const normalizedName = normalizeAssetFileName(fileName);
    const uniqueStem = `${Date.now()}-${String(sha256 || '').slice(0, 12)}`;
    const objectKey = `generic/${uniqueStem}-${normalizedName}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const uploadSessionId = `generic-upload-${now.getTime()}-${crypto.randomBytes(8).toString('hex')}`;
    
    const uploadUrl = await presignS3Url({
      method: 'PUT',
      objectKey,
      contentType,
      expiresSeconds: 900,
    });
    
    const readUrl = await presignS3Url({
      method: 'GET',
      objectKey,
      expiresSeconds: 7 * 24 * 60 * 60, // 7 days (maximum for presigned URLs typically)
    });

    const intent = {
      alreadyUploaded: false,
      upload: {
        uploadSessionId,
        objectKey,
        uploadUrl,
        headers: { 'Content-Type': contentType },
        expiresAt,
        readUrl,
      }
    };

    res.status(201).json({
      success: true,
      intent,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      intent: null,
      error: error.message,
    });
  }
});

app.post('/api/assets/upload-intent', requireAssetEntityPermission('write', assetEntityTypeFromBody), async (req, res) => {
  try {
    const intent = await createAssetUploadIntent(req.body || {});
    res.status(intent.alreadyUploaded ? 200 : 201).json({
      success: true,
      intent,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      intent: null,
      error: error.message,
    });
  }
});

app.post('/api/assets/upload-complete', requireAssetEntityPermission('write', assetEntityTypeFromUploadSession), async (req, res) => {
  try {
    const asset = await completeAssetUpload(req.body || {});
    res.json({ success: true, asset, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      asset: null,
      error: error.message,
    });
  }
});

app.post('/api/assets/:id/read-url', requireAssetEntityPermission('read', assetEntityTypeFromAssetId), async (req, res) => {
  try {
    const payload = await createAssetReadUrl(Number(req.params.id));
    res.json({ success: true, ...payload, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      asset: null,
      readUrl: null,
      error: error.message,
    });
  }
});

app.patch('/api/assets/:id/primary', requireAssetEntityPermission('write', assetEntityTypeFromAssetId), async (req, res) => {
  try {
    const asset = await setPrimaryAsset(Number(req.params.id));
    res.json({ success: true, asset, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      asset: null,
      error: error.message,
    });
  }
});

app.delete('/api/assets/:id', requireAssetEntityPermission('write', assetEntityTypeFromAssetId), async (req, res) => {
  try {
    await deleteAsset(Number(req.params.id));
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post('/api/delete-s3-object', requirePermission('config.write'), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL is required' });
    try {
      const parsedUrl = new URL(url);
      const objectKey = parsedUrl.pathname.substring(1);
      const s3Client = getS3Client();
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: objectKey,
      }));
      // Update db status to deleted just in case
      await run("UPDATE uploaded_assets SET status = 'deleted' WHERE object_key = ?", [objectKey]);
      res.json({ success: true, error: null });
    } catch (e) {
      res.status(500).json({ success: false, error: 'Failed to delete S3 object: ' + e.message });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
