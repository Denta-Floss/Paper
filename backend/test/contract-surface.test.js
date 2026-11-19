const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// Every operation the modules publish at the kernel desk, with its contract,
// pinned in a fixture: the name, who it is for (a permission, or other modules
// only), what it takes, what it returns, how strictly it is held, and which
// modules have declared that they ask for it.
//
// This is each module's API written down. A module is only a separate service
// if the things asked of it cannot change quietly, and this is where a change
// shows: a renamed field, a contract loosened from enforce back to report, a
// new module reaching into another, an operation that started needing the
// caller's transaction.
//
// A deliberate change is recorded with:
//
//   UPDATE_CONTRACT_SNAPSHOT=1 npm test
//
// and the fixture diff is the review.

const FIXTURE = path.join(__dirname, 'fixtures', 'contract-surface.json');

test('the operations the modules publish, and their contracts, are the ones in the fixture', () => {
  const tempDir = makeTempDir('paper-contract-surface-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'contract-surface@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');

  const surface = {
    operations: backend.desk.catalogue(),
    // Who has declared they ask what: the dependency map between modules.
    uses: backend.desk.declaredUses(),
  };
  assert.ok(surface.operations.length >= 20, `expected the published operations, saw ${surface.operations.length}`);

  if (process.env.UPDATE_CONTRACT_SNAPSHOT === '1') {
    fs.writeFileSync(FIXTURE, `${JSON.stringify(surface, null, 2)}\n`);
    return;
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const byName = (list) => new Map(list.map((operation) => [operation.name, operation]));
  const have = byName(surface.operations);
  const want = byName(expected.operations);

  // Named first, so the failure says WHICH operation rather than printing two
  // long lists that differ somewhere.
  const added = [...have.keys()].filter((name) => !want.has(name));
  const removed = [...want.keys()].filter((name) => !have.has(name));
  const changed = [...have.keys()].filter(
    (name) => want.has(name) && JSON.stringify(have.get(name)) !== JSON.stringify(want.get(name)),
  );
  assert.deepEqual(
    { added, removed, changed },
    { added: [], removed: [], changed: [] },
    'the contract surface changed; if intended, run UPDATE_CONTRACT_SNAPSHOT=1 npm test',
  );
  assert.deepEqual(surface.uses, expected.uses, 'which module asks what of whom changed');
});

test('every operation a module declares it uses exists', () => {
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  const missing = [];
  for (const [module, names] of Object.entries(backend.desk.declaredUses())) {
    for (const name of names) {
      if (!backend.desk.has(name)) missing.push(`${module} → ${name}`);
    }
  }
  assert.deepEqual(missing, [], 'a module declares a use of an operation nobody publishes');
});

// Every field a user-facing operation takes says what it is. The exceptions are
// the fields whose type really is "either of two": a filter that may be a list
// or a comma-separated string, a record id that may be a number or a barcode,
// a part-code value list that may be an array or a joined string, and the two
// payloads whose service answers each element for itself (route steps, unit
// conversions), where a contract would speak before the service does.
const UNTYPED_ON_PURPOSE = new Set([
  'orders.list.statuses',
  'orders.list.ids',
  'action_center.trash.restore.data.recordId',
  'action_center.deleteRequests.create.data.entityId',
  'items.nextPartIdentity.query.values',
  'inventory.movements.record.data.referenceId',
  'process_routes.routes.save.steps',
  'process_routes.routes.version.steps',
  'units.convertBatch.conversions[].value',
  'units.convertBatch.conversions[].fromUnitId',
  'units.convertBatch.conversions[].toUnitId',
]);

function untypedFields(spec, path, out) {
  const resolved = typeof spec === 'function' ? spec() : spec;
  if (!resolved) return;
  if (resolved.type === 'any') out.push(path);
  if (resolved.type === 'object' && resolved.fields) {
    for (const [name, field] of Object.entries(resolved.fields)) untypedFields(field, `${path}.${name}`, out);
  }
  if (resolved.type === 'array' && resolved.items) untypedFields(resolved.items, `${path}[]`, out);
}

test('every field a user operation takes is typed, except the ones listed here on purpose', () => {
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  const untyped = [];
  for (const operation of backend.desk.catalogue()) {
    if (operation.internal) continue;
    for (const [name, field] of Object.entries(operation.input || {})) {
      untypedFields(field, `${operation.name}.${name}`, untyped);
    }
  }
  const surprises = untyped.filter((path) => !UNTYPED_ON_PURPOSE.has(path));
  assert.deepEqual(surprises, [], 'a user operation has a field whose type the contract does not say');
  const stale = [...UNTYPED_ON_PURPOSE].filter((path) => !untyped.includes(path));
  assert.deepEqual(stale, [], 'an exception listed here is no longer untyped; take it off the list');
});
