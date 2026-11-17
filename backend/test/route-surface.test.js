const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Every "METHOD /path" the server answers, as a sorted list, pinned in a
// fixture.
//
// Moving a module out of server.js is meant to change WHERE a route is
// declared and nothing about WHAT answers. That claim is cheap to break in
// three quiet ways: a route is dropped with the block that held it, a route is
// registered twice (Express answers with the first, and the second never runs),
// or a path moves behind a different registration order. All three show up here
// as a diff in this list, long before a client notices.
//
// A legitimate change to the surface (a new route, a deliberate removal) is
// recorded with:
//
//   UPDATE_ROUTE_SNAPSHOT=1 npm test
//
// and the fixture diff is the review.

const FIXTURE = path.join(__dirname, 'fixtures', 'route-surface.json');

function listRoutes(app) {
  const stack = (app.router && app.router.stack) || app._router.stack;
  const out = [];
  // Into mounted routers as well: server.js mounts one where each route group
  // used to be.
  const walk = (layers) => {
    for (const layer of layers) {
      if (!layer.route) {
        if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack);
        continue;
      }
      const route = layer.route;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const p of paths) {
        for (const method of Object.keys(route.methods || {})) {
          if (route.methods[method]) out.push(`${method.toUpperCase()} ${String(p)}`);
        }
      }
    }
  };
  walk(stack);
  return out.sort();
}

test('the set of routes the server answers is the one in the fixture', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-route-surface-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'route-surface@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  const routes = listRoutes(backend.app);
  assert.ok(routes.length > 200, `expected the full surface, saw ${routes.length}`);

  if (process.env.UPDATE_ROUTE_SNAPSHOT === '1') {
    fs.writeFileSync(FIXTURE, `${JSON.stringify(routes, null, 2)}\n`);
    return;
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const count = (list) => list.reduce((m, r) => m.set(r, (m.get(r) || 0) + 1), new Map());
  const have = count(routes);
  const want = count(expected);
  const missing = [...want].filter(([r, n]) => (have.get(r) || 0) < n).map(([r]) => r);
  const extra = [...have].filter(([r, n]) => (want.get(r) || 0) < n).map(([r]) => r);
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    'route surface changed; if intended, run UPDATE_ROUTE_SNAPSHOT=1 npm test',
  );
});
