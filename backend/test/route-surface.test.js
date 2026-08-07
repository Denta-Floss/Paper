const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const territory = require('../kernel/territory');

// The API surface as a committed snapshot.
//
// Module evacuation physically moves route registrations between files. The
// domain functions are well covered by tests that call them directly, but the
// ROUTE WIRING barely is — before this file, exactly two challans HTTP routes
// were exercised anywhere in the suite. A move that dropped, renamed, or
// double-registered a route would have shipped silently.
//
// This test pins method+path for every mounted /api route. Adding or removing
// a route is then a deliberate act: run with UPDATE_ROUTE_SNAPSHOT=1 to
// re-record, and the diff shows up in review.

const SNAPSHOT = path.join(__dirname, 'fixtures', 'route-surface.json');

function mountedRoutes(app) {
  return territory
    .collectExpressRoutes(app)
    .filter((route) => route.path.startsWith('/api/'))
    .map((route) => `${route.method} ${route.path}`)
    .sort();
}

test('the mounted /api route surface matches the committed snapshot', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-route-surface-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'routes@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');

  try {
    const actual = mountedRoutes(backend.app);
    assert.ok(actual.length > 200, `expected a full route table, got ${actual.length}`);

    if (process.env.UPDATE_ROUTE_SNAPSHOT === '1' || !fs.existsSync(SNAPSHOT)) {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const missing = expected.filter((route) => !actual.includes(route));
    const added = actual.filter((route) => !expected.includes(route));

    assert.deepEqual(
      { missing, added },
      { missing: [], added: [] },
      'The API surface changed. If this is intentional (a route moved between '
        + 'modules, or a new endpoint landed), re-record with '
        + 'UPDATE_ROUTE_SNAPSHOT=1 npm test so the change is reviewable.',
    );
  } finally {
    await backend.closeDb?.();
  }
});

test('no /api route is registered twice with the same method', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-route-dupes-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');

  try {
    const seen = new Map();
    const duplicates = [];
    for (const route of territory.collectExpressRoutes(backend.app)) {
      if (!route.path.startsWith('/api/')) continue;
      const key = `${route.method} ${route.path}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      if (seen.get(key) === 2) duplicates.push(key);
    }
    // Express silently lets the FIRST registration win, so a duplicate left
    // behind by a half-finished move is invisible at runtime — the old handler
    // keeps serving while the new one looks live in the source.
    assert.deepEqual(duplicates, [], `Duplicate route registrations:\n  ${duplicates.join('\n  ')}`);
  } finally {
    await backend.closeDb?.();
  }
});

test('every module with declared path segments actually serves them', async () => {
  const registry = require('../kernel/registry');
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-route-claims-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');

  try {
    const paths = territory
      .collectExpressRoutes(backend.app)
      .map((route) => route.path)
      .filter((p) => p.startsWith('/api/'));
    const servedSegments = new Set(paths.map((p) => p.slice('/api/'.length).split('/')[0]));

    const phantom = [];
    for (const moduleKey of registry.CRUD_MODULES) {
      for (const segment of registry.MODULES[moduleKey].pathSegments || []) {
        if (!servedSegments.has(segment)) {
          phantom.push(`${moduleKey} declares /api/${segment} but nothing serves it`);
        }
      }
    }
    // A declared-but-unserved segment is how the jobs module ended up with
    // permission keys that gated nothing: its routes lived at
    // /api/freelancer-jobs while the manifest claimed /api/jobs.
    assert.deepEqual(phantom, [], phantom.join('\n  '));
  } finally {
    await backend.closeDb?.();
  }
});
