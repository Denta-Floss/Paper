const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Kernel rule K5 guard-rail: modules reach other modules ONLY through ports.
//
// This is a static test on purpose. The runtime cost of a K5 violation is
// invisible (the code works — it just couples two modules), so nothing else
// would ever catch a regression. Here the boundary is a build-time fact.
//
// When you legitimately need one of these helpers from new code, add a port
// and call it — do not add an exception here.

const SERVER = path.join(__dirname, '../server.js');

// Items-owned helpers that non-items code must reach only via itemsPorts.*
// value: the functions ALLOWED to call it directly (its own module's internals)
const ITEMS_INTERNAL_CALLERS = {
  applyVariationStockDelta: ['applyVariationStockDelta'],
  assertValidStockVariationLeaf: ['applyVariationStockDelta'],
  getItemSelectionSnapshot: [
    'getItemSelectionSnapshot',
    // The items<->materials bridge: spans both territories, ownership is an
    // open decision (see Docs/architecture/00-kernel-and-items-evacuation.md).
    'ensureMaterialForItemSelection',
  ],
  resolveOrderVariationSelection: [
    'resolveOrderVariationSelection',
    'getItemSelectionSnapshot',
  ],
};

function enclosingFunctionByLine(source) {
  const lines = source.split('\n');
  const owner = new Array(lines.length).fill('<module scope>');
  let current = '<module scope>';
  const declaration = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = declaration.exec(lines[i]);
    if (match) {
      current = match[1];
    }
    owner[i] = current;
  }
  return owner;
}

test('cross-module calls into items helpers go through itemsPorts', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  const lines = source.split('\n');
  const owner = enclosingFunctionByLine(source);

  const violations = [];
  for (const [helper, allowed] of Object.entries(ITEMS_INTERNAL_CALLERS)) {
    const call = new RegExp(`(?<!\\.)\\b${helper}\\s*\\(`);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Skip the declaration itself and any port wiring (which is the sanctioned
      // place these names appear).
      if (new RegExp(`function\\s+${helper}\\b`).test(line)) continue;
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      if (!call.test(line)) continue;
      const fn = owner[i];
      if (allowed.includes(fn)) continue;
      // The ports object wires implementations by reference — that IS the door.
      if (/^\s*(?:stockApplyDelta|stockAssertLeaf|selectionSnapshot|resolveSelection|bomLines|describe)\s*:/.test(line)) continue;
      violations.push(`${helper} called directly in ${fn}() at server.js:${i + 1}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `K5 violation — these must go through itemsPorts.*:\n  ${violations.join('\n  ')}`,
  );
});

test('variation_stock is written through exactly one door', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  const writes = source
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /(INSERT\s+INTO|UPDATE)\s+variation_stock/i.test(line));

  // The single writer is applyVariationStockDelta (reached via
  // itemsPorts.stock.applyDelta from other modules). Deletes on item cascade
  // are allowed — they remove rows, they do not move stock.
  const owner = enclosingFunctionByLine(source);
  const writers = [...new Set(writes.map(({ index }) => owner[index]))];

  assert.deepEqual(
    writers,
    ['applyVariationStockDelta'],
    `variation_stock must have exactly one writer, found: ${writers.join(', ')}`,
  );
});

test('every items port has a real implementation wired', () => {
  const { createItemsPorts } = require('../modules/items/ports');
  // A port whose impl is missing throws at construction; a port whose impl is a
  // stub is worse (silently wrong), so assert the shape is complete here and
  // let items-module.test.js exercise behaviour.
  const noop = () => {};
  const ports = createItemsPorts({
    describe: noop,
    resolveSelection: noop,
    selectionSnapshot: noop,
    stockAssertLeaf: noop,
    stockApplyDelta: noop,
    bomLines: noop,
    lookupByName: noop,
    deleteEntity: noop,
    ensureReconcilePrimary: noop,
    ensureReconcileSub: noop,
    ensureForReconcile: noop,
  });
  const stats = ports.stats();
  assert.ok(Object.keys(stats).length >= 11, 'expected every port to be metered');
  assert.ok('stock.applyDelta' in stats);
  assert.ok('bom.lines' in stats);

  // A missing implementation must fail loudly at construction, not at the
  // first call from some rarely-exercised path.
  assert.throws(
    () => createItemsPorts({ describe: noop }),
    /has no implementation/,
  );
});

test('server.js declares no module maps of its own (registry is the source)', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  // These were duplicated inline once; the duplicates silently drifted from the
  // manifests the territory meter reads. The registry is the only declaration.
  for (const name of [
    'CRUD_MODULES',
    'MODULE_LABELS',
    'CAPABILITY_DESCRIPTORS',
    'FINE_PERMISSION_DESCRIPTORS',
    'TRACK_ENTITY_LABELS',
    'RECORD_OPTION_SOURCES',
    'ASSET_ENTITY_PERMISSIONS',
  ]) {
    assert.ok(
      !new RegExp(`^const ${name}\\s*=\\s*[[{]`, 'm').test(source),
      `${name} must come from kernel/registry.js, not be re-declared in server.js`,
    );
  }
  assert.match(source, /require\('\.\/kernel\/registry'\)/);
});
