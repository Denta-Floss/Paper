const assert = require('node:assert/strict');
const test = require('node:test');

const { reconcile } = require('../kernel/reconcile');
const registry = require('../kernel/registry');

// The reconciler is a pure function over injected state, so drift can be
// simulated exactly: build a fake Express app + fake DB reader describing a
// deployment, and assert the report names the disagreement.

function fakeApp(routePaths) {
  return {
    _router: {
      stack: routePaths.map((path) => ({
        route: { path, methods: { get: true } },
      })),
    },
  };
}

// A deployment where reality matches every declaration: one route per declared
// path segment, every declared table present, migrations all applied.
function healthyFixture() {
  const routePaths = [];
  for (const key of registry.CRUD_MODULES) {
    for (const segment of registry.MODULES[key].pathSegments || []) {
      routePaths.push(`/api/${segment}`);
    }
  }
  routePaths.push('/api/production/pipeline-templates');
  const tables = new Set();
  for (const key of registry.CRUD_MODULES) {
    for (const table of registry.MODULES[key].tables || []) {
      tables.add(table);
    }
  }
  return { routePaths, tables: [...tables] };
}

function makeAllRows({ tables, applied }) {
  return async (sql) => {
    if (/_migrations/.test(sql)) {
      if (applied === null) {
        throw new Error('SQLITE_ERROR: no such table: _migrations');
      }
      return applied.map((name) => ({ name }));
    }
    return tables.map((name) => ({ name }));
  };
}

function makeGetRow(config) {
  return async () => (config ? { config_json: JSON.stringify(config) } : null);
}

test('reconciler reports converged when reality matches every declaration', async () => {
  const { routePaths, tables } = healthyFixture();
  const migrationFiles = ['001-init.sql', '002-next.sql'];
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: migrationFiles }),
    getRow: makeGetRow({
      modules: {
        orders: true,
        inventory: true,
        production: true,
        jobs: true,
        delivery_challans: true,
        actionCenter: true,
        masters: true,
      },
    }),
    migrationFiles,
    moduleDirs: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated),
  });

  assert.equal(report.converged, true, `expected no errors, got: ${JSON.stringify(report.drift, null, 2)}`);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.migrations.applied, 2);
});

test('reconciler flags a declared table that does not exist', async () => {
  const { routePaths, tables } = healthyFixture();
  const withoutVariationStock = tables.filter((t) => t !== 'variation_stock');
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables: withoutVariationStock, applied: [] }),
    getRow: makeGetRow(null),
    migrationFiles: [],
    moduleDirs: ['items'],
  });

  const finding = report.drift.find((d) => d.kind === 'table-missing' && d.subject === 'module:items');
  assert.ok(finding, 'expected a table-missing finding for items');
  assert.match(finding.detail, /variation_stock/);
  assert.equal(report.converged, false);
});

test('reconciler flags declared-but-unmounted module routes', async () => {
  const { tables } = healthyFixture();
  // Mount nothing at all: every module with path segments is unreachable.
  const report = await reconcile({
    app: fakeApp([]),
    allRows: makeAllRows({ tables, applied: [] }),
    getRow: makeGetRow(null),
    migrationFiles: [],
    moduleDirs: ['items'],
  });

  const unmounted = report.drift.filter((d) => d.kind === 'routes-unmounted');
  assert.ok(unmounted.length >= 5, 'expected many unmounted modules');
  assert.ok(unmounted.some((d) => d.subject === 'module:items'));
});

test('reconciler flags pending and unknown migrations', async () => {
  const { routePaths, tables } = healthyFixture();
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: ['001-init.sql', '999-from-the-future.sql'] }),
    getRow: makeGetRow(null),
    migrationFiles: ['001-init.sql', '002-pending.sql'],
    moduleDirs: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated),
  });

  const pending = report.drift.find((d) => d.kind === 'migrations-pending');
  assert.ok(pending, 'expected pending migration finding');
  assert.match(pending.detail, /002-pending\.sql/);

  const unknown = report.drift.find((d) => d.kind === 'migrations-unknown');
  assert.ok(unknown, 'expected unknown migration finding');
  assert.match(unknown.detail, /999-from-the-future\.sql/);
});

test('reconciler reports a database that never ran the migration runner', async () => {
  const { routePaths, tables } = healthyFixture();
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: null }),
    getRow: makeGetRow(null),
    migrationFiles: ['001-init.sql'],
    moduleDirs: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated),
  });

  const untracked = report.drift.find((d) => d.kind === 'migrations-untracked');
  assert.ok(untracked, 'expected migrations-untracked finding');
  assert.equal(report.summary.migrations.tracked, false);
});

test('reconciler flags config module flags the registry cannot gate', async () => {
  const { routePaths, tables } = healthyFixture();
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: [] }),
    getRow: makeGetRow({ modules: { orders: true, pm: true, telepathy: true } }),
    migrationFiles: [],
    moduleDirs: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated),
  });

  const unmapped = report.drift.filter((d) => d.kind === 'config-flag-unmapped');
  const subjects = unmapped.map((d) => d.subject);
  // `pm` (preventative maintenance) is a real flag in the shipped config with
  // no kernel module behind it — the reconciler must not stay silent about it.
  assert.ok(subjects.includes('config:modules.pm'), `expected pm flagged, got ${subjects}`);
  assert.ok(subjects.includes('config:modules.telepathy'));
});

test('reconciler flags a module collapsed in config whose routes still answer', async () => {
  const { routePaths, tables } = healthyFixture();
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: [] }),
    getRow: makeGetRow({ modules: { orders: false } }),
    migrationFiles: [],
    moduleDirs: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated),
  });

  const finding = report.drift.find((d) => d.kind === 'module-disabled-but-mounted');
  assert.ok(finding, 'expected disabled-but-mounted finding');
  assert.match(finding.actual, /orders/);
  assert.equal(finding.severity, 'error');
});

test('reconciler flags an evacuation claim with no module package on disk', async () => {
  const { routePaths, tables } = healthyFixture();
  const report = await reconcile({
    app: fakeApp(routePaths),
    allRows: makeAllRows({ tables, applied: [] }),
    getRow: makeGetRow(null),
    migrationFiles: [],
    moduleDirs: [], // items claims evacuated: true but no package present
  });

  const finding = report.drift.find((d) => d.kind === 'evacuation-claimed-without-package');
  assert.ok(finding, 'expected evacuation claim to be challenged');
  assert.equal(finding.severity, 'error');
});
