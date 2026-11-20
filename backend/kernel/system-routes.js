'use strict';

// ---------------------------------------------------------------------------
// The server about itself.
//
//   GET /api/system/status    any signed-in user — what the Sync Health screen
//                             reads: versions, the API compatibility window,
//                             the changelog head, the server's clock. Small
//                             and uncached, so timing it is a ping.
//   GET /api/system/metrics   an admin, or a scraper holding PAPER_METRICS_TOKEN
//                             as its Bearer token — kernel/telemetry.js. JSON,
//                             or the Prometheus text format for
//                             ?format=prometheus or an Accept of text/plain.
//
// Registered ahead of the login gate so the scraper's token can be checked
// before a session is asked for; each route carries its own guard.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');

/// The API contract's version. Bumped when a change would break a client built
/// against the previous one. A server answers clients at API_VERSION and one
/// before it; a client answers servers at its version and one before it — so a
/// rollback of either side by one release keeps working (N / N-1).
const API_VERSION = 1;
const MIN_CLIENT_API_VERSION = API_VERSION - 1;

function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function registerSystemRoutesBeforeLogin(app, {
  get,
  requireAuth,
  telemetry,
  dbPath,
  release,
  serverVersion,
  environment,
  metricsToken = process.env.PAPER_METRICS_TOKEN || '',
}) {
  app.get('/api/system/status', requireAuth, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let head = 0;
    try {
      const row = await get('SELECT COALESCE(MAX(id), 0) AS head FROM changelog');
      head = Number(row?.head || 0);
    } catch (_) {
      head = null;
    }
    res.json({
      success: true,
      serverVersion,
      release: release.release,
      commit: release.commit,
      startedAt: release.startedAt,
      environment,
      apiVersion: API_VERSION,
      minClientApiVersion: MIN_CLIENT_API_VERSION,
      changelogHead: head,
      serverTime: new Date().toISOString(),
    });
  });

  const answerMetrics = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const snap = telemetry.snapshot({ dbPath });
    const wantsText = req.query.format === 'prometheus' ||
      (req.query.format !== 'json' && /text\/plain/.test(String(req.headers.accept || '')));
    if (wantsText) {
      res.type('text/plain; version=0.0.4').send(telemetry.prometheus(snap));
      return;
    }
    res.json({ success: true, serverVersion, apiVersion: API_VERSION, ...snap });
  };

  app.get('/api/system/metrics', (req, res, next) => {
    if (tokenMatches(bearer(req), metricsToken)) {
      answerMetrics(req, res);
      return;
    }
    requireAuth(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }
      if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') {
        res.status(403).json({ success: false, error: 'Only an admin can read the server metrics.' });
        return;
      }
      answerMetrics(req, res);
    });
  });
}

module.exports = { registerSystemRoutesBeforeLogin, API_VERSION, MIN_CLIENT_API_VERSION, tokenMatches };
