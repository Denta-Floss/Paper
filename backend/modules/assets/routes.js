'use strict';

// ---------------------------------------------------------------------------
// Assets: files attached to records. Upload intents and completions, viewing
// through signed links, a part's photo gallery, and photo requests sent to a
// user's phone.
//
//   GET    /api/assets/local/*key
//   GET    /api/assets/view/*key
//   POST   /api/upload/generic
//   POST   /api/assets/upload-intent
//   POST   /api/assets/upload-complete
//   POST   /api/assets/:id/read-url
//   PATCH  /api/assets/:id/primary
//   POST   /api/assets/primary
//   PATCH  /api/assets/:id/title
//   DELETE /api/assets/:id
//   POST   /api/photo-requests
//   GET    /api/photo-requests
//   POST   /api/photo-requests/:id/complete
//   POST   /api/photo-requests/:id/skip
//   DELETE /api/photo-requests/:id
//   POST   /api/delete-s3-object
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// These are registered ahead of the login gate: they answer without a session.
function registerAssetsRoutesBeforeLogin(app, {
  ALLOWED_ASSET_CONTENT_TYPES,
  IMMUTABLE_CACHE_CONTROL,
  LOCAL_UPLOAD_CONTENT_TYPES,
  assertLocalUploadSigned,
  assetViewSignature,
  get,
  localObjectKeyFrom,
  localUploadPath,
  presignS3Url,
}) {
  app.get('/api/assets/local/*key', async (req, res) => {
    try {
      const objectKey = localObjectKeyFrom(req);
      assertLocalUploadSigned(req, 'GET', objectKey);
      const file = localUploadPath(objectKey);
      if (!fs.existsSync(file)) {
        res.status(404).json({ success: false, error: 'Not found.' });
        return;
      }
      // The type the upload declared, which the asset row keeps; the file's
      // extension only when there is no row (a name without one served every
      // photo as a download rather than an image).
      const recorded = await get(
        'SELECT content_type, file_name, document_title FROM uploaded_assets WHERE object_key = ? LIMIT 1',
        [objectKey],
      );
      if (recorded && recorded.document_title != null) {
        // A document is served as what it is, but only a PDF or a picture is
        // shown in the browser; anything else is a download, never rendered.
        const type = recorded.content_type || 'application/octet-stream';
        const shown = type === 'application/pdf' || ALLOWED_ASSET_CONTENT_TYPES.has(type);
        const name = String(recorded.file_name || 'document').replace(/["\\\r\n]/g, '_');
        res.setHeader('Content-Type', shown ? type : 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `${shown ? 'inline' : 'attachment'}; filename="${name}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        fs.createReadStream(file).pipe(res);
        return;
      }
      const type =
        (recorded?.content_type &&
          ALLOWED_ASSET_CONTENT_TYPES.has(recorded.content_type) &&
          recorded.content_type) ||
        LOCAL_UPLOAD_CONTENT_TYPES[path.extname(file).toLowerCase()] ||
        'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  // A photo field's permanent link: checked once, then sent on to a fresh read
  // URL for wherever the object lives (S3, or the local store above).
  app.get('/api/assets/view/*key', async (req, res) => {
    try {
      const objectKey = localObjectKeyFrom(req);
      const given = String(req.query?.sig || '');
      const wanted = assetViewSignature(objectKey);
      if (
        given.length !== wanted.length ||
        !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(wanted))
      ) {
        res.status(403).json({ success: false, error: 'This photo link is not valid.' });
        return;
      }
      // The object behind a key never changes, so its signed URL can live an
      // hour and the redirect be reused for most of it — every photo on screen
      // is not a fresh round trip a minute later.
      const readUrl = await presignS3Url({ method: 'GET', objectKey, expiresSeconds: 3600 });
      res.setHeader('Cache-Control', 'private, max-age=3000');
      res.redirect(302, readUrl);
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });
}

function registerAssetsRoutes(app, {
  ASSET_ENTITY_PERMISSIONS,
  DOCUMENT_ENTITY_TYPES,
  PHOTO_REQUEST_TYPES,
  all,
  announcePhotoRequests,
  assertAssetEntityExists,
  assertRoomForPhoto,
  assetEntityTypeFromAssetId,
  assetEntityTypeFromBody,
  assetEntityTypeFromUploadSession,
  assetReadUrlPayload,
  assetViewUrl,
  closePhotoRequest,
  completeAssetUpload,
  createAssetReadUrl,
  createAssetUploadIntent,
  deleteAsset,
  get,
  hasPermission,
  normalizeAssetFileName,
  normalizeDocumentTitle,
  nowIso,
  photoRequestDetails,
  photoRequestDto,
  photoRequestError,
  presignS3Url,
  renameDocument,
  requireAssetEntityPermission,
  requireGenericUploadPermission,
  run,
  setPrimaryAsset,
}) {
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
          // What to save: readUrl stops working in seven days.
          viewUrl: assetViewUrl(objectKey),
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
        code: error.code || null,
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
        code: error.code || null,
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

  // The primary photo of many records of one kind, signed, in one request — a
  // table of parts or people shows a thumbnail per row, and a request per row
  // was the alternative.
  app.post('/api/assets/primary', requireAssetEntityPermission('read', assetEntityTypeFromBody), async (req, res) => {
    try {
      const entityType = String(req.body?.entityType || '').trim().toLowerCase();
      if (!ASSET_ENTITY_PERMISSIONS[entityType]) {
        res.status(400).json({ success: false, photos: {}, error: 'Entity type not supported.' });
        return;
      }
      const ids = [
        ...new Set(
          (Array.isArray(req.body?.entityIds) ? req.body.entityIds : [])
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      ].slice(0, 500);
      const photos = {};
      if (ids.length > 0) {
        const rows = await all(
          `
          SELECT *
          FROM uploaded_assets
          WHERE entity_type = ? AND status = 'uploaded' AND is_primary = 1
            AND entity_id IN (${ids.map(() => '?').join(',')})
          `,
          [entityType, ...ids],
        );
        // How many each keeps, for a slot's count ("3 photos").
        const counts = new Map(
          (
            await all(
              `
              SELECT entity_id, COUNT(*) AS count
              FROM uploaded_assets
              WHERE entity_type = ? AND status = 'uploaded' AND document_title IS NULL
                AND entity_id IN (${ids.map(() => '?').join(',')})
              GROUP BY entity_id
              `,
              [entityType, ...ids],
            )
          ).map((row) => [Number(row.entity_id), Number(row.count)]),
        );
        for (const row of rows) {
          try {
            const payload = await assetReadUrlPayload(row.object_key, 3600);
            photos[String(row.entity_id)] = {
              assetId: row.id,
              sha256: row.sha256 || '',
              readUrl: payload.readUrl,
              // The small copy, for a slot in a list: a few KB, not the photo.
              thumbReadUrl: row.thumb_key
                ? (await assetReadUrlPayload(row.thumb_key, 3600)).readUrl
                : null,
              count: counts.get(Number(row.entity_id)) || 1,
              expiresAt: payload.expiresAt,
            };
          } catch (_) {
            // One unreadable object does not cost the rest their thumbnails.
          }
        }
      }
      res.json({ success: true, photos, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, photos: {}, error: error.message });
    }
  });

  app.patch('/api/assets/:id/title', requireAssetEntityPermission('write', assetEntityTypeFromAssetId), async (req, res) => {
    try {
      const document = await renameDocument(Number(req.params.id), req.body?.title);
      res.json({ success: true, document, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, document: null, error: error.message });
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

  app.post('/api/photo-requests', async (req, res) => {
    try {
      const entityType = String(req.body?.entityType || '').trim().toLowerCase();
      const entityId = Number(req.body?.entityId || 0);
      if (!PHOTO_REQUEST_TYPES.includes(entityType) || !Number.isInteger(entityId) || entityId <= 0) {
        throw photoRequestError('A photo is asked for a part, company, person, die or machine by its id.', 400);
      }
      if (!hasPermission(req, ASSET_ENTITY_PERMISSIONS[entityType].write)) {
        throw photoRequestError('You do not have permission to add photos to this record.', 403);
      }
      const rawTitle = req.body?.documentTitle;
      let documentTitle = null;
      if (rawTitle !== undefined && rawTitle !== null) {
        if (!DOCUMENT_ENTITY_TYPES.has(entityType)) {
          throw photoRequestError('Documents are kept for a client or a contractor.', 400);
        }
        documentTitle = normalizeDocumentTitle(rawTitle);
      }
      await assertAssetEntityExists(entityType, entityId);
      // A part with all its photos has no room for the phone's: said here, not
      // after the shot is taken and the upload refused.
      if (documentTitle == null) await assertRoomForPhoto(entityType, entityId);
      const userId = Number(req.user.id);
      const context = String(req.body?.context || '').trim().slice(0, 200);
      // A second click on the same slot is the same job, not a second photo —
      // and a document is the same job only under the same name.
      let row = await get(
        `SELECT * FROM photo_requests
          WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND status = 'pending'
            AND COALESCE(document_title, '') = ?`,
        [userId, entityType, entityId, documentTitle || ''],
      );
      let created = false;
      if (!row) {
        const now = nowIso();
        const result = await run(
          `INSERT INTO photo_requests (user_id, entity_type, entity_id, context, status, created_at, updated_at, document_title)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [userId, entityType, entityId, context, now, now, documentTitle],
        );
        row = await get('SELECT * FROM photo_requests WHERE id = ?', [result.lastID]);
        created = true;
        announcePhotoRequests(userId);
      }
      res.status(created ? 201 : 200).json({
        success: true,
        request: photoRequestDto(row, await photoRequestDetails(entityType, entityId, documentTitle)),
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code || null });
    }
  });

  app.get('/api/photo-requests', async (req, res) => {
    try {
      const status = String(req.query?.status || 'pending');
      const rows = await all(
        'SELECT * FROM photo_requests WHERE user_id = ? AND status = ? ORDER BY id ASC',
        [Number(req.user.id), status],
      );
      const requests = [];
      for (const row of rows) {
        const details = await photoRequestDetails(row.entity_type, row.entity_id, row.document_title ?? null);
        // A record deleted since it was asked for has nothing left to photograph.
        if (details) requests.push(photoRequestDto(row, details));
      }
      res.json({ success: true, requests, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/photo-requests/:id/complete', (req, res) => {
    const assetId = Number(req.body?.assetId || 0);
    return closePhotoRequest(req, res, 'done', assetId > 0 ? assetId : null);
  });

  app.post('/api/photo-requests/:id/skip', (req, res) => closePhotoRequest(req, res, 'skipped'));

  app.delete('/api/photo-requests/:id', (req, res) => closePhotoRequest(req, res, 'cancelled'));
}

// These are registered after the /api error handler that sits in the middle of
// server.js, as they always were, so an error they pass on is caught by the
// last handler instead.
function registerAssetsRoutesAfterErrorHandler(app, {
  DeleteObjectCommand,
  assertS3Configured,
  getS3Client,
  requirePermission,
  run,
}) {
  app.post('/api/delete-s3-object', requirePermission('config.write'), async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ success: false, error: 'URL is required' });
      try {
        const parsedUrl = new URL(url);
        const objectKey = parsedUrl.pathname.substring(1);
        const s3Client = getS3Client();
        await s3Client.send(new DeleteObjectCommand({
          // The configured bucket (PAPER_S3_BUCKET_NAME); S3_BUCKET alone was
          // unset on the servers, so this deleted nothing.
          Bucket: assertS3Configured().bucket,
          Key: objectKey,
        }));
        // Update db status to deleted just in case
        await run(
          "UPDATE uploaded_assets SET status = 'deleted', deleted_at = ? WHERE object_key = ?",
          [new Date().toISOString(), objectKey],
        );
        res.json({ success: true, error: null });
      } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to delete S3 object: ' + e.message });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerAssetsRoutesBeforeLogin,
  registerAssetsRoutes,
  registerAssetsRoutesAfterErrorHandler,
};
