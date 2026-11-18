const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-contract-surface-'));
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
