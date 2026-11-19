const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// An item with no variations holds stock: one figure for the whole item, kept
// in variation_stock under leaf 0. Before this such an item could hold none,
// and a stock-tracked reception for it was refused. An item WITH variations
// still has to say which variation.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = makeTempDir('paper-whole-item-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'whole@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'whole@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) => fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { backend, server, api };
}

async function plainItem(backend, name) {
  const like = await backend.get('SELECT group_id, unit_id FROM items LIMIT 1');
  await backend.run(
    `INSERT INTO items (name, display_name, group_id, unit_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [name, name, like.group_id, like.unit_id],
  );
  return backend.get('SELECT * FROM items WHERE name = ?', [name]);
}

const wholeStock = async (backend, itemId) => (await backend.get(
  'SELECT COALESCE(SUM(quantity), 0) AS q FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = 0',
  [itemId],
)).q;

test('an item with no variations is received, used, returned and cancelled through its own stock figure', async (t) => {
  const { backend, server, api } = await boot();
  t.after(() => server.close());
  const item = await plainItem(backend, 'Plain Washer');
  const vendor = (await api('POST', '/api/vendors', { name: 'Whole Item Vendor' })).body.vendor;
  const receive = async (challanNo) => {
    const made = await api('POST', '/api/challans', {
      type: 'reception', challanNo, date: '2026-11-15', status: 'draft', maintainStocks: true,
      vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase',
      items: [{ itemId: item.id, particulars: 'Plain Washer', quantityPcs: '5', lineNo: 1 }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const issued = await api('POST', `/api/challans/${made.body.data.id}/issue`, {});
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    return made.body.data;
  };

  const first = await receive('WI-REC-1');
  assert.equal(await wholeStock(backend, item.id), 5, 'the item itself now has 5');
  const material = await backend.get('SELECT * FROM materials WHERE source_challan_id = ?', [first.id]);
  assert.equal(material.linked_item_id, item.id);
  assert.equal(material.linked_variation_leaf_node_id, null);

  // Using the received material lowers the item's figure with it.
  const used = await api('POST', '/api/inventory/movements', {
    barcode: 'WI-REC-1-L1', movementType: 'consume', qty: 2, referenceType: 'test', referenceId: 'whole',
  });
  assert.equal(used.status, 201, JSON.stringify(used.body));
  assert.equal(await wholeStock(backend, item.id), 3);

  // Partly used: a return for the rest, which leaves the item's figure once.
  const cancel = await api('POST', `/api/challans/${first.id}/cancel`, {});
  assert.equal(cancel.body.outcome, 'return_challan_created', JSON.stringify(cancel.body));
  const ret = cancel.body.returnChallan;
  assert.equal(Number(ret.items[0].quantity_pcs), 3);
  const sent = await api('POST', `/api/challans/${ret.id}/issue`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(await wholeStock(backend, item.id), 0);

  // Untouched: the cancel takes all of it back, once.
  const second = await receive('WI-REC-2');
  assert.equal(await wholeStock(backend, item.id), 5);
  const gone = await api('POST', `/api/challans/${second.id}/cancel`, {});
  assert.equal(gone.body.data.status, 'cancelled', JSON.stringify(gone.body));
  assert.equal(await wholeStock(backend, item.id), 0);

  // And it shows in the stock overview under the item's name.
  await receive('WI-REC-3');
  const overview = await api('GET', '/api/inventory/stock');
  const row = overview.body.stock.find((entry) => Number(entry.itemId ?? entry.item_id) === item.id);
  assert.ok(row, 'the overview lists the item');
  assert.equal(Number(row.quantity), 5);
});

test('an item with variations still has to say which variation', async (t) => {
  const { backend, server, api } = await boot();
  t.after(() => server.close());
  const item = await backend.get(
    `SELECT i.* FROM items i WHERE EXISTS (
       SELECT 1 FROM item_variation_nodes n WHERE n.item_id = i.id AND n.kind = 'value' AND n.is_archived = 0) LIMIT 1`,
  );
  const vendor = (await api('POST', '/api/vendors', { name: 'Leaf Vendor' })).body.vendor;
  const made = await api('POST', '/api/challans', {
    type: 'reception', challanNo: 'WI-LEAF-1', date: '2026-11-15', status: 'draft', maintainStocks: true,
    vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase',
    items: [{ itemId: item.id, particulars: 'No variation named', quantityPcs: '5', lineNo: 1 }],
  });
  // Refused at save or at issue, but never stocked under leaf 0.
  if (made.status === 201) {
    const issued = await api('POST', `/api/challans/${made.body.data.id}/issue`, {});
    assert.equal(issued.status, 400, JSON.stringify(issued.body));
  } else {
    assert.equal(made.status, 400, JSON.stringify(made.body));
  }
  const row = await backend.get(
    'SELECT COUNT(*) AS c FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = 0', [item.id]);
  assert.equal(row.c, 0);
});

test('a material linked to an item with no variations gets its stock figure at boot, once', async (t) => {
  const { backend, server } = await boot();
  t.after(() => server.close());
  const item = await plainItem(backend, 'Plain Rivet');
  await backend.run(
    `INSERT INTO materials (barcode, name, type, kind, location, on_hand_qty, linked_item_id, created_at)
     VALUES ('PLAIN-RIVET-1', 'Plain Rivet', 'pc', 'parent', 'MAIN', 4, ?, datetime('now'))`,
    [item.id],
  );
  assert.equal(await wholeStock(backend, item.id), 0);
  await backend.initDb();
  assert.equal(await wholeStock(backend, item.id), 4);
  await backend.initDb();
  assert.equal(await wholeStock(backend, item.id), 4, 'a second boot does not add it again');
});

test('a database made before whole-item stock is rebuilt once and keeps its rows', async (t) => {
  const { backend, server } = await boot();
  t.after(() => server.close());
  const leaf = await backend.get(
    "SELECT id, item_id FROM item_variation_nodes WHERE kind = 'value' AND is_archived = 0 LIMIT 1");
  // Put the table back the way it used to be: leaf must be above zero.
  await backend.run('DROP TABLE variation_stock');
  await backend.run(
    `CREATE TABLE variation_stock (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE CHECK (item_id > 0),
       variation_leaf_node_id INTEGER NOT NULL REFERENCES item_variation_nodes(id) ON DELETE CASCADE CHECK (variation_leaf_node_id > 0),
       quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
       location_id TEXT DEFAULT 'MAIN',
       updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(item_id, variation_leaf_node_id, location_id))`,
  );
  await backend.run(
    'INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity) VALUES (?, ?, 12.5)',
    [leaf.item_id, leaf.id],
  );
  await assert.rejects(
    backend.run('INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity) VALUES (?, 0, 1)', [leaf.item_id]),
    /CHECK|FOREIGN/,
  );

  await backend.initDb();

  const kept = await backend.get(
    'SELECT * FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = ?', [leaf.item_id, leaf.id]);
  assert.equal(kept.quantity, 12.5, 'the old row came across');
  assert.equal(kept.variation_path_node_ids_json, '[]', 'and gained the columns it lacked');
  const table = await backend.get("SELECT sql FROM sqlite_master WHERE name = 'variation_stock'");
  assert.doesNotMatch(table.sql, /variation_leaf_node_id\s*>\s*0/);
  await backend.initDb();
  assert.equal((await backend.get('SELECT COUNT(*) AS c FROM variation_stock')).c, 1, 'and a second boot leaves it alone');

  // The leaf is no longer a foreign key, so deleting it removes its stock here.
  await backend.run('DELETE FROM item_variation_nodes WHERE id = ?', [leaf.id]).catch(() => {});
  const after = await backend.get('SELECT COUNT(*) AS c FROM item_variation_nodes WHERE id = ?', [leaf.id]);
  if (after.c === 0) {
    assert.equal((await backend.get('SELECT COUNT(*) AS c FROM variation_stock WHERE variation_leaf_node_id = ?', [leaf.id])).c, 0);
  }
});

test('a database whose stock table only has the leaf as a foreign key is rebuilt too', async (t) => {
  const { backend, server } = await boot();
  t.after(() => server.close());
  const leaf = await backend.get(
    "SELECT id, item_id FROM item_variation_nodes WHERE kind = 'value' AND is_archived = 0 LIMIT 1");
  // The shape real databases made before the CHECK was added: no CHECK on the
  // leaf, but the leaf is a foreign key, which refuses 0 just the same.
  await backend.run('DROP TRIGGER IF EXISTS trg_variation_stock_leaf_gone');
  await backend.run('DROP TABLE variation_stock');
  await backend.run(
    `CREATE TABLE variation_stock (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
       variation_leaf_node_id INTEGER NOT NULL REFERENCES item_variation_nodes(id) ON DELETE CASCADE,
       quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
       location_id TEXT DEFAULT 'MAIN',
       updated_at TEXT DEFAULT (datetime('now')),
       UNIQUE(item_id, variation_leaf_node_id, location_id))`,
  );
  await backend.run(
    'INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity) VALUES (?, ?, 8)',
    [leaf.item_id, leaf.id],
  );
  await assert.rejects(
    backend.run('INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity) VALUES (?, 0, 1)', [leaf.item_id]),
    /FOREIGN KEY/,
  );

  await backend.initDb();

  const kept = await backend.get(
    'SELECT quantity FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = ?', [leaf.item_id, leaf.id]);
  assert.equal(kept.quantity, 8, 'the old row came across');
  const table = await backend.get("SELECT sql FROM sqlite_master WHERE name = 'variation_stock'");
  assert.doesNotMatch(table.sql, /REFERENCES\s+item_variation_nodes/i);
  // And leaf 0 is now accepted by the table.
  await backend.run('INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity) VALUES (?, 0, 1)', [leaf.item_id]);
  await backend.initDb();
  assert.equal((await backend.get('SELECT COUNT(*) AS c FROM variation_stock')).c, 2, 'a second boot leaves it alone');
});
