const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const registry = require('../kernel/registry');
const { makeTempDir } = require('./helpers/temp-dir');

// The border meter: every place a module's code names a table it does not own.
//
// A module is only a separate service if it keeps to its own tables and asks
// its neighbours for theirs. Today it does not, in a great many places, and
// those cannot all be fixed at once. So the crossings that exist are written
// down in a fixture, and from here on the list may only get shorter:
//
//   - a NEW crossing fails this test. Ask the owning module at the kernel desk
//     instead of reaching into its table.
//   - a crossing that is GONE also fails, until the fixture is updated, so
//     progress is recorded and cannot quietly be undone:
//
//       UPDATE_BORDER_SNAPSHOT=1 npm test
//
//     which refuses to write a list that grew.
//
// A crossing is "<folder> <reads|writes|schema> <owner>.<table>": the module
// folder the code is in, what it does, and whose table it is.
//
// A read can be DECLARED: a module's manifest in kernel/registry.js lists the
// table under `reads` with the reason. It is still a crossing and still in the
// fixture, marked "(declared)" and counted apart, because a declared read is a
// decision somebody made and can be held to, and an undeclared one is not.
//
// What this does not see, and so does not claim: server.js (its business logic
// leaves for the modules, where it will be counted); SQL whose table name is
// built at run time; and the seed and dev-tool folders, which write everything
// on purpose.

const MODULES_DIR = path.join(__dirname, '..', 'modules');
const FIXTURE = path.join(__dirname, 'fixtures', 'module-borders.json');

// Folders that are not one registered module, and whose tables they may touch.
const FOLDER_OWNERS = {
  // Shared by the client and vendor masters.
  parties: ['clients', 'vendors'],
  payroll: ['payroll'],
  // Kernel services that have their own folder.
  accounts: ['kernel'],
  assets: ['kernel'],
  control_plane: ['kernel'],
  kernel: ['kernel'],
  links: ['kernel'],
  realtime: ['kernel'],
  search: ['kernel'],
  settings: ['kernel'],
  track: ['kernel'],
  variations: ['kernel'],
};
const NOT_SCANNED = new Set(['scenarios', 'devtools']);

function ownersOfFolder(folder) {
  if (registry.MODULES[folder]) return [folder];
  return FOLDER_OWNERS[folder] || null;
}

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

// SQL in this codebase is written with upper-case keywords, which is what lets
// "FROM items" in a statement be told from "from items" in a sentence.
const TABLE_REF = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_]*)\b/g;

function crossingsIn(folder, source) {
  const mine = new Set(ownersOfFolder(folder));
  const found = new Set();
  const text = stripComments(source);
  for (const match of text.matchAll(TABLE_REF)) {
    const [, keyword, table] = match;
    const owner = registry.TABLE_OWNERS[table];
    if (!owner || mine.has(owner)) continue;
    let access = 'reads';
    if (keyword === 'INTO' || keyword === 'UPDATE') access = 'writes';
    else if (keyword === 'TABLE') access = 'schema';
    else if (keyword === 'FROM' && /DELETE\s+$/.test(text.slice(Math.max(0, match.index - 12), match.index))) {
      access = 'writes';
    }
    const declared = access === 'reads' && Boolean(registry.MODULES[folder]?.reads?.[table]);
    found.add(`${folder} ${access} ${owner}.${table}${declared ? ' (declared)' : ''}`);
  }
  return found;
}

function scan() {
  const crossings = new Set();
  const unknownFolders = [];
  for (const entry of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_SCANNED.has(entry.name)) continue;
    if (!ownersOfFolder(entry.name)) {
      unknownFolders.push(entry.name);
      continue;
    }
    for (const file of jsFiles(path.join(MODULES_DIR, entry.name))) {
      for (const crossing of crossingsIn(entry.name, fs.readFileSync(file, 'utf8'))) {
        crossings.add(crossing);
      }
    }
  }
  return { crossings: [...crossings].sort(), unknownFolders };
}

function summarise(crossings) {
  const count = (test) => crossings.filter(test).length;
  const part = (crossing) => crossing.split(' ');
  const kernelFolder = (crossing) => (FOLDER_OWNERS[part(crossing)[0]] || []).includes('kernel');
  const kernelTable = (crossing) => part(crossing)[2].startsWith('kernel.');
  const declared = (crossing) => crossing.endsWith(' (declared)');
  return {
    total: crossings.length,
    declaredReads: count(declared),
    moduleReadsModule: count((c) => !kernelFolder(c) && !kernelTable(c) && part(c)[1] === 'reads' && !declared(c)),
    moduleWritesModule: count((c) => !kernelFolder(c) && !kernelTable(c) && part(c)[1] !== 'reads'),
    moduleTouchesKernelTable: count((c) => !kernelFolder(c) && kernelTable(c)),
    kernelServiceTouchesModuleTable: count((c) => kernelFolder(c)),
  };
}

test('the scanner tells a read from a write, and its own tables from a neighbour’s', () => {
  const found = [...crossingsIn('orders', `
    // FROM items in a comment is not a crossing
    await get('SELECT * FROM order_items WHERE id = ?');
    await all(\`SELECT c.name FROM order_items o JOIN clients c ON c.id = o.client_id\`);
    await run('INSERT OR IGNORE INTO materials (barcode) VALUES (?)');
    await run('UPDATE pipeline_runs SET status = ?');
    await run('DELETE FROM  freelancer_jobs WHERE id = ?');
    await run('INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2');
    await run('CREATE TABLE IF NOT EXISTS units (id INTEGER)');
    await all('SELECT * FROM entity_links');
  `)].sort();
  assert.deepEqual(found, [
    'orders reads clients.clients',
    'orders reads kernel.entity_links',
    'orders schema units.units',
    'orders writes inventory.materials',
    'orders writes jobs.freelancer_jobs',
    'orders writes production.pipeline_runs',
  ]);
  // A read the module's manifest declares is marked, not hidden.
  assert.deepEqual([...crossingsIn('production', "all('SELECT 1 FROM production_runs pr JOIN items i ON i.id = pr.item_id')")], [
    'production reads items.items (declared)',
  ]);
  assert.deepEqual([...crossingsIn('parties', "get('SELECT 1 FROM clients'); get('SELECT 1 FROM vendors'); get('SELECT 1 FROM items')")], [
    'parties reads items.items',
  ]);
});

test('every table a fresh database has belongs to a module or the kernel', async () => {
  const tempDir = makeTempDir('paper-module-borders-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'borders@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.initDb();
  const rows = await backend.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const unowned = rows.map((row) => row.name).filter((name) => !registry.TABLE_OWNERS[name]).sort();
  assert.deepEqual(unowned, [], 'give each of these an owner in kernel/registry.js');
});

test('no module folder is left out of the meter by accident', () => {
  assert.deepEqual(scan().unknownFolders, [], 'say in FOLDER_OWNERS whose tables this folder may touch');
});

test('the places a module touches a table it does not own: none added, and none removed unrecorded', () => {
  const { crossings } = scan();
  const summary = summarise(crossings);

  if (process.env.UPDATE_BORDER_SNAPSHOT === '1') {
    const before = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).crossings : null;
    const grew = before ? crossings.filter((crossing) => !before.includes(crossing)) : [];
    assert.ok(
      grew.length === 0 || process.env.ALLOW_BORDER_GROWTH === '1',
      `refusing to record new crossings:\n  ${grew.join('\n  ')}`,
    );
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ summary, crossings }, null, 2)}\n`);
    return;
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const added = crossings.filter((crossing) => !expected.crossings.includes(crossing));
  const removed = expected.crossings.filter((crossing) => !crossings.includes(crossing));
  assert.deepEqual(
    added,
    [],
    'a module reaches into a table it does not own; ask the owner at the kernel desk instead',
  );
  assert.deepEqual(
    removed,
    [],
    'crossings were removed (good): record it with UPDATE_BORDER_SNAPSHOT=1 npm test',
  );
  assert.deepEqual(summary, expected.summary);
  // Since P4 (2026-11-19): every read of another module's table is either an
  // ask at the desk or declared in the registry with its reason.
  assert.equal(summary.moduleReadsModule, 0, 'a module reads another module\'s table without asking or declaring it');
});
