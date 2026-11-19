const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The exact stock rows a challan writes when it is issued and when it is
// cancelled: the movement ledger, the minted material and its position, and the
// item's variation stock.
//
// Written before that SQL moved from the challans module to behind the
// inventory port, so "nothing changed" is checked row by row rather than
// assumed.
//
// It also holds the rule for cancelling a reception. While everything it
// brought in is still free, the cancel takes the received material itself out
// of stock. Once any of it is used, reserved or claimed by a run, the reception
// stays issued and a draft vendor return is made for what is free. Deleting an
// issued reception follows the same rule. A vendor sheet scanned onto a run
// takes its stock off the reception's material, and a return of scanned sheets
// leaves that same material.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function boot() {
  const tempDir = makeTempDir('paper-challan-stock-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'challanstock@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'challanstock@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  return {
    backend,
    server,
    baseUrl,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
  };
}

function api(ctx, method, route, body) {
  return fetch(`${ctx.baseUrl}${route}`, {
    method,
    headers: ctx.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const MOVEMENT_FIELDS = `material_barcode, movement_type, qty, primary_qty, uom, to_location_id, reason_code,
  reference_type, reference_id, source_challan_id, source_challan_type, source_challan_line_id,
  reverses_movement_id, lot_code, item_id, variation_leaf_node_id, actor, id`;

async function setup(ctx) {
  const item = await ctx.backend.get('SELECT * FROM items LIMIT 1');
  const leaf = await ctx.backend.get(
    `SELECT n.* FROM item_variation_nodes n
      WHERE n.item_id = ? AND n.kind = 'value' AND n.is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM item_variation_nodes c WHERE c.parent_node_id = n.id AND c.is_archived = 0)
      LIMIT 1`,
    [item.id],
  );
  assert.ok(item && leaf, 'demo seed must provide an item with a variation leaf');
  const vendor = (await api(ctx, 'POST', '/api/vendors', { name: 'Stock Rows Vendor' })).body.vendor;
  const make = async (challanNo, type, extra = {}) => {
    const res = await api(ctx, 'POST', '/api/challans', {
      type,
      challanNo,
      date: '2026-08-26',
      status: 'draft',
      customerName: 'x',
      maintainStocks: true,
      items: [{ itemId: item.id, variationLeafNodeId: leaf.id, particulars: 'Line', quantityPcs: '5', weight: '10', lineNo: 1 }],
      ...extra,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };
  const stock = async () => (await ctx.backend.get(
    'SELECT quantity FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = ?',
    [item.id, leaf.id],
  ))?.quantity ?? 0;
  const movements = (challanId) => ctx.backend.all(
    `SELECT ${MOVEMENT_FIELDS} FROM inventory_movements WHERE source_challan_id = ? ORDER BY rowid`,
    [challanId],
  );
  return { item, leaf, vendor, make, stock, movements };
}

test('issuing a reception mints a material, a stock position and one receive movement', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { item, leaf, vendor, make, stock, movements } = await setup(ctx);
  const before = await stock();

  const challan = await make('SR-REC-1', 'reception', { vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase' });
  const issued = await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const lineId = issued.body.data.items[0].id;

  const material = await ctx.backend.get('SELECT * FROM materials WHERE source_challan_id = ?', [challan.id]);
  assert.equal(material.barcode, 'SR-REC-1-L1', 'the barcode is the challan number and the line');
  assert.equal(material.name, 'Line');
  assert.equal(material.kind, 'parent');
  assert.equal(material.material_class, 'raw_material');
  assert.equal(material.inventory_state, 'available');
  assert.equal(material.on_hand_qty, 5);
  assert.equal(material.available_to_promise_qty, 5);
  assert.equal(material.linked_item_id, item.id);
  assert.equal(material.linked_variation_leaf_node_id, leaf.id);
  assert.equal(material.source_challan_item_id, lineId);
  assert.equal(material.supplier, 'Stock Rows Vendor');
  assert.equal(material.location, 'MAIN');

  const position = await ctx.backend.get('SELECT * FROM inventory_stock_positions WHERE material_barcode = ?', ['SR-REC-1-L1']);
  assert.equal(position.location_id, 'MAIN');
  assert.equal(position.lot_code, 'SR-REC-1-L1');
  assert.equal(position.on_hand_qty, 5);
  assert.equal(position.reserved_qty, 0);

  const rows = await movements(challan.id);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.match(m.id, /^mov-/);
  assert.equal(m.material_barcode, 'SR-REC-1-L1');
  assert.equal(m.movement_type, 'receive');
  assert.equal(m.qty, 5);
  assert.equal(m.primary_qty, 5);
  assert.equal(m.to_location_id, 'MAIN');
  assert.equal(m.reason_code, 'reception_challan_issue');
  assert.equal(m.reference_type, 'challan');
  assert.equal(m.reference_id, String(challan.id));
  assert.equal(m.source_challan_type, 'reception');
  assert.equal(m.source_challan_line_id, lineId);
  assert.equal(m.reverses_movement_id, null);
  assert.equal(m.lot_code, '-');
  assert.equal(m.item_id, item.id);
  assert.equal(m.variation_leaf_node_id, leaf.id);
  assert.ok(m.actor);

  assert.equal(await stock(), before + 5, 'and the item has 5 more of that variation');

  // Issuing again must not mint a second pile.
  const again = await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  assert.ok(again.status >= 200);
  const count = await ctx.backend.get('SELECT COUNT(*) AS c FROM materials WHERE source_challan_id = ?', [challan.id]);
  assert.equal(count.c, 1);
});

test('issuing an outgoing challan writes one issue movement against no barcode and takes the stock', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { item, leaf, vendor, make, stock, movements } = await setup(ctx);
  const inward = await make('SR-REC-2', 'reception', { vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase' });
  await api(ctx, 'POST', `/api/challans/${inward.id}/issue`, {});
  const before = await stock();

  const out = await make('SR-OUT-1', 'internal', { purpose: 'internal_use' });
  const issued = await api(ctx, 'POST', `/api/challans/${out.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  const rows = await movements(out.id);
  assert.equal(rows.length, 1);
  const m = rows[0];
  assert.equal(m.material_barcode, '-', 'an outgoing line names no physical piece');
  assert.equal(m.movement_type, 'issue');
  assert.equal(m.qty, 5);
  assert.equal(m.reason_code, 'delivery_challan_issue');
  assert.equal(m.reference_type, 'challan');
  assert.equal(m.source_challan_type, 'internal');
  assert.equal(m.lot_code, '-');
  assert.equal(m.item_id, item.id);
  assert.equal(m.variation_leaf_node_id, leaf.id);
  assert.equal(await stock(), before - 5);
  const minted = await ctx.backend.get('SELECT COUNT(*) AS c FROM materials WHERE source_challan_id = ?', [out.id]);
  assert.equal(minted.c, 0, 'nothing is minted for stock going out');
});

test('cancelling writes one reversal per movement, linked to it, and puts the variation stock back', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make, stock, movements } = await setup(ctx);
  const start = await stock();

  const inward = await make('SR-REC-3', 'reception', { vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase' });
  await api(ctx, 'POST', `/api/challans/${inward.id}/issue`, {});
  const out = await make('SR-OUT-2', 'internal', { purpose: 'internal_use' });
  await api(ctx, 'POST', `/api/challans/${out.id}/issue`, {});
  assert.equal(await stock(), start);

  assert.equal((await api(ctx, 'POST', `/api/challans/${out.id}/cancel`, {})).status, 200);
  const outRows = await movements(out.id);
  assert.equal(outRows.length, 2);
  const [outIssue, outReverse] = outRows;
  assert.equal(outReverse.movement_type, 'receive', 'an issue is reversed by a receive');
  assert.equal(outReverse.material_barcode, '-');
  assert.equal(outReverse.qty, 5);
  assert.equal(outReverse.reason_code, 'challan_cancel_reversal');
  assert.equal(outReverse.reference_type, 'challan-cancellation');
  assert.equal(outReverse.reference_id, String(out.id));
  assert.equal(outReverse.reverses_movement_id, outIssue.id, 'and names the movement it undoes');
  assert.equal(outReverse.source_challan_line_id, outIssue.source_challan_line_id);
  assert.equal(outReverse.lot_code, '-');
  assert.equal(await stock(), start + 5);

  const cancelled = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, 'cancelled');
  assert.equal(cancelled.body.outcome, undefined, 'an untouched reception is simply cancelled');
  const inRows = await movements(inward.id);
  assert.equal(inRows.length, 2);
  assert.equal(inRows[1].movement_type, 'issue', 'a receive is reversed by an issue');
  assert.equal(inRows[1].material_barcode, 'SR-REC-3-L1');
  assert.equal(inRows[1].qty, 5);
  assert.equal(inRows[1].reason_code, 'challan_cancel_reversal');
  assert.equal(inRows[1].reference_type, 'challan-cancellation');
  assert.equal(inRows[1].reverses_movement_id, inRows[0].id);
  assert.equal(inRows[1].lot_code, 'SR-REC-3-L1', 'taken from the lot the stock sits in');
  assert.equal(await stock(), start, 'the variation stock is back where it began, once and not twice');

  // The received material itself is out of stock, and no longer listed.
  const material = await ctx.backend.get('SELECT * FROM materials WHERE barcode = ?', ['SR-REC-3-L1']);
  assert.equal(material.on_hand_qty, 0);
  assert.equal(material.available_to_promise_qty, 0);
  assert.equal(material.inventory_state, 'cancelled');
  const position = await ctx.backend.get('SELECT on_hand_qty FROM inventory_stock_positions WHERE material_barcode = ?', ['SR-REC-3-L1']);
  assert.equal(position.on_hand_qty, 0);
  const listed = await api(ctx, 'GET', '/api/materials');
  assert.ok(!listed.body.materials.some((m) => m.barcode === 'SR-REC-3-L1'), 'a cancelled reception leaves nothing in the materials list');

  // Cancelling twice writes nothing more.
  await api(ctx, 'POST', `/api/challans/${out.id}/cancel`, {});
  assert.equal((await movements(out.id)).length, 2);
});

async function receive(ctx, make, vendor, challanNo) {
  const challan = await make(challanNo, 'reception', { vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase' });
  const issued = await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return challan;
}

function move(ctx, barcode, movementType, qty) {
  return api(ctx, 'POST', '/api/inventory/movements', {
    barcode, movementType, qty, referenceType: 'test', referenceId: 'stock-rows',
  });
}

const positionQty = async (ctx, barcode) => (await ctx.backend.get(
  'SELECT COALESCE(SUM(on_hand_qty), 0) AS q FROM inventory_stock_positions WHERE material_barcode = ?',
  [barcode],
)).q;

test('a partly used reception is not cancelled: a draft vendor return is made for what is left', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { item, leaf, vendor, make, stock, movements } = await setup(ctx);
  const start = await stock();
  const inward = await receive(ctx, make, vendor, 'SR-REC-4');
  assert.equal((await move(ctx, 'SR-REC-4-L1', 'consume', 2)).status, 201);
  assert.equal(await stock(), start + 3);

  const res = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'issued', 'the reception happened and stays');
  assert.equal(res.body.outcome, 'return_challan_created');
  assert.match(res.body.message, /2 of 5/);
  assert.match(res.body.message, /remaining 3/);
  const ret = res.body.returnChallan;
  assert.equal(ret.status, 'draft');
  assert.equal(ret.type, 'internal');
  assert.equal(ret.internalSubtype, 'vendor_return');
  assert.equal(ret.sourceReceptionChallanId, inward.id);
  assert.equal(ret.vendor_name ?? ret.vendorName, 'Stock Rows Vendor', 'it goes back to the vendor it came from');
  assert.equal(ret.items.length, 1);
  assert.equal(ret.items[0].materialBarcode, 'SR-REC-4-L1');
  assert.equal(ret.items[0].item_id, item.id);
  assert.equal(ret.items[0].variation_leaf_node_id, leaf.id);
  assert.equal(Number(ret.items[0].quantity_pcs), 3);

  // Nothing moved yet: the return is only a draft.
  assert.equal((await movements(inward.id)).length, 1);
  assert.equal(await positionQty(ctx, 'SR-REC-4-L1'), 3);
  assert.equal(await stock(), start + 3);

  // Pressing cancel again hands back the same return, not a second one.
  const again = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(again.body.returnChallan.id, ret.id);
  const returns = await ctx.backend.get(
    'SELECT COUNT(*) AS c FROM delivery_challans WHERE source_reception_challan_id = ?', [inward.id]);
  assert.equal(returns.c, 1);

  // Issuing the return takes the stock off the received material itself.
  const issued = await api(ctx, 'POST', `/api/challans/${ret.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const out = await movements(ret.id);
  assert.equal(out.length, 1);
  assert.equal(out[0].material_barcode, 'SR-REC-4-L1', 'the return names the material it sends back');
  assert.equal(out[0].movement_type, 'issue');
  assert.equal(out[0].qty, 3);
  assert.equal(out[0].reason_code, 'vendor_return_issue');
  assert.equal(out[0].source_challan_type, 'internal');
  assert.equal(await positionQty(ctx, 'SR-REC-4-L1'), 0);
  assert.equal(await stock(), start, 'the item has none of that reception left');
  const material = await ctx.backend.get('SELECT on_hand_qty FROM materials WHERE barcode = ?', ['SR-REC-4-L1']);
  assert.equal(material.on_hand_qty, 0);

  // With everything used or returned there is nothing to cancel or send back.
  const refused = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(refused.status, 409, JSON.stringify(refused.body));

  // Cancelling the issued return puts the stock back on the material.
  const undone = await api(ctx, 'POST', `/api/challans/${ret.id}/cancel`, {});
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.data.status, 'cancelled');
  assert.equal(await positionQty(ctx, 'SR-REC-4-L1'), 3);
  assert.equal(await stock(), start + 3);
  const back = await movements(ret.id);
  assert.equal(back.length, 2);
  assert.equal(back[1].movement_type, 'receive');
  assert.equal(back[1].reverses_movement_id, back[0].id);
});

test('stock reserved for a run counts as used', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make } = await setup(ctx);
  const inward = await receive(ctx, make, vendor, 'SR-REC-5');
  assert.equal((await move(ctx, 'SR-REC-5-L1', 'reserve', 2)).status, 201);

  const res = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'issued');
  assert.equal(Number(res.body.returnChallan.items[0].quantity_pcs), 3, 'only the unreserved stock can go back');

  // The return cannot be edited up to take the reserved stock.
  const ret = res.body.returnChallan;
  const edited = await api(ctx, 'PUT', `/api/challans/${ret.id}`, {
    ...ret,
    items: ret.items.map((line) => ({ ...line, quantityPcs: '5', quantity_pcs: '5' })),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.items[0].materialBarcode, 'SR-REC-5-L1', 'an edit keeps the material the line returns');
  const issued = await api(ctx, 'POST', `/api/challans/${ret.id}/issue`, {});
  assert.equal(issued.status, 409, JSON.stringify(issued.body));
  assert.equal(await positionQty(ctx, 'SR-REC-5-L1'), 5, 'and a refused issue moves nothing');
});

test('a sheet scanned onto a run counts as used, though no movement records it', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make } = await setup(ctx);
  const inward = await receive(ctx, make, vendor, 'SR-REC-6');
  const line = await ctx.backend.get('SELECT id FROM delivery_challan_items WHERE challan_id = ?', [inward.id]);
  const runRow = await ctx.backend.get('SELECT id FROM pipeline_runs LIMIT 1');
  await ctx.backend.run(
    `INSERT INTO run_barcode_inputs (id, run_id, node_id, barcode, material_payload_json, source_kind, challan_item_id, consumed_weight)
     VALUES ('rbi-stock-rows', ?, 'n1', 'SHEET-1', '{}', 'sheet', ?, 4)`,
    [runRow?.id || 'run-x', line.id],
  );

  const res = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'issued');
  assert.equal(res.body.outcome, 'return_challan_created');
  // The demo item is counted in pieces, so one sheet is one piece.
  assert.equal(Number(res.body.returnChallan.items[0].quantity_pcs), 4);
});

test('a reception with nothing left free cannot be cancelled', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make, movements } = await setup(ctx);
  const inward = await receive(ctx, make, vendor, 'SR-REC-7');
  assert.equal((await move(ctx, 'SR-REC-7-L1', 'consume', 5)).status, 201);

  const res = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error || res.body.message, /already used/);
  const row = await ctx.backend.get('SELECT status FROM delivery_challans WHERE id = ?', [inward.id]);
  assert.equal(row.status, 'issued');
  assert.equal((await movements(inward.id)).length, 1);
  const returns = await ctx.backend.get(
    'SELECT COUNT(*) AS c FROM delivery_challans WHERE source_reception_challan_id = ?', [inward.id]);
  assert.equal(returns.c, 0);
});

async function tagSheets(ctx, challanId, codes) {
  const line = await ctx.backend.get('SELECT id FROM delivery_challan_items WHERE challan_id = ?', [challanId]);
  const res = await api(ctx, 'POST', `/api/challans/${challanId}/piece-barcodes`, {
    barcodes: codes.map((code) => ({ challanItemId: line.id, parentCode: code, childCode: `${code}-C`, weight: 2 })),
  });
  assert.ok(res.status < 300, JSON.stringify(res.body));
  return line;
}

async function startRun(ctx) {
  const template = await ctx.backend.get('SELECT * FROM pipeline_templates LIMIT 1');
  const res = await fetch(`${ctx.baseUrl}/runs`, {
    method: 'POST', headers: ctx.headers, body: JSON.stringify({ templateId: template.id, name: 'Stock Rows Run' }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.run.id;
}

const runCall = (ctx, method, route, body) => fetch(`${ctx.baseUrl}${route}`, {
  method, headers: ctx.headers, body: body ? JSON.stringify(body) : undefined,
});

test('deleting an untouched issued reception takes its stock back and removes it', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make, stock } = await setup(ctx);
  const start = await stock();
  const inward = await receive(ctx, make, vendor, 'SR-REC-8');
  assert.equal(await stock(), start + 5);

  const gone = await api(ctx, 'DELETE', `/api/challans/${inward.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(await ctx.backend.get('SELECT id FROM delivery_challans WHERE id = ?', [inward.id]), undefined);
  assert.equal(await stock(), start);
  assert.equal(await positionQty(ctx, 'SR-REC-8-L1'), 0);
  const material = await ctx.backend.get('SELECT on_hand_qty, inventory_state FROM materials WHERE barcode = ?', ['SR-REC-8-L1']);
  assert.equal(material.on_hand_qty, 0);
  assert.equal(material.inventory_state, 'cancelled');
  const reversal = await ctx.backend.get(
    "SELECT * FROM inventory_movements WHERE material_barcode = ? AND movement_type = 'issue'", ['SR-REC-8-L1']);
  assert.equal(reversal.reason_code, 'challan_delete_reversal');
  assert.equal(reversal.reference_type, 'challan-deletion');
});

test('a partly used reception cannot be deleted', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make } = await setup(ctx);
  const inward = await receive(ctx, make, vendor, 'SR-REC-9');
  assert.equal((await move(ctx, 'SR-REC-9-L1', 'consume', 2)).status, 201);

  const refused = await api(ctx, 'DELETE', `/api/challans/${inward.id}`);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.ok(await ctx.backend.get('SELECT id FROM delivery_challans WHERE id = ?', [inward.id]));
  assert.equal(await positionQty(ctx, 'SR-REC-9-L1'), 3, 'and nothing moved');
});

test('a sheet scanned onto a run takes its stock off the received material, and gives it back when removed', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { vendor, make, stock } = await setup(ctx);
  const start = await stock();
  const inward = await receive(ctx, make, vendor, 'SR-REC-10');
  await tagSheets(ctx, inward.id, ['SHT-A', 'SHT-B']);
  const runId = await startRun(ctx);

  const scanned = await runCall(ctx, 'POST', `/runs/${runId}/barcodes`, { nodeId: 'node-1', barcode: 'SHT-A' });
  assert.equal(scanned.status, 200, await scanned.text());
  // The demo item is counted, so one sheet is one piece.
  assert.equal(await positionQty(ctx, 'SR-REC-10-L1'), 4);
  assert.equal(await stock(), start + 4);
  const input = await ctx.backend.get('SELECT * FROM run_barcode_inputs WHERE run_id = ?', [runId]);
  assert.equal(input.source_kind, 'sheet');
  assert.equal(input.consumed_qty, 1);
  const consume = await ctx.backend.get(
    "SELECT * FROM inventory_movements WHERE material_barcode = ? AND movement_type = 'consume'", ['SR-REC-10-L1']);
  assert.equal(consume.qty, 1);
  assert.equal(consume.reference_type, 'pipeline_run');
  assert.equal(consume.reference_id, String(runId));

  // The reception is now partly used, and the sheet is counted once, not twice.
  const cancel = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(cancel.body.outcome, 'return_challan_created', JSON.stringify(cancel.body));
  assert.equal(Number(cancel.body.returnChallan.items[0].quantity_pcs), 4);

  const removed = await runCall(ctx, 'DELETE', `/runs/${runId}/barcodes/node-1/SHT-A`);
  assert.equal(removed.status, 200, await removed.text());
  assert.equal(await positionQty(ctx, 'SR-REC-10-L1'), 5);
  assert.equal(await stock(), start + 5);
});

test('a return of scanned sheets leaves the material its reception brought in', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const { item, leaf, vendor, make, stock, movements } = await setup(ctx);
  const start = await stock();
  const inward = await receive(ctx, make, vendor, 'SR-REC-11');
  await tagSheets(ctx, inward.id, ['SHT-R']);

  // What the phone sends: an internal vendor-return naming only the sheet.
  const ret = await make('SR-RET-1', 'internal', {
    internalSubtype: 'vendor_return',
    internalPurpose: 'Vendor return',
    returnedSheetCodes: ['SHT-R'],
    vendorId: vendor.id,
    vendorName: vendor.name,
    items: [{ itemId: item.id, variationLeafNodeId: leaf.id, particulars: 'Line', quantityPcs: '1', weight: '2', lineNo: 1 }],
  });
  assert.equal(ret.sourceReceptionChallanId, inward.id, 'the sheet says which reception it came in on');
  assert.equal(ret.items[0].materialBarcode, 'SR-REC-11-L1');
  assert.equal(ret.vendor_name ?? ret.vendorName, 'Stock Rows Vendor');

  const issued = await api(ctx, 'POST', `/api/challans/${ret.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const out = await movements(ret.id);
  assert.equal(out.length, 1);
  assert.equal(out[0].material_barcode, 'SR-REC-11-L1');
  assert.equal(out[0].qty, 1);
  assert.equal(await positionQty(ctx, 'SR-REC-11-L1'), 4);
  assert.equal(await stock(), start + 4, 'the item is lowered once');
  const sheet = await ctx.backend.get('SELECT returned_at, returned_challan_id FROM piece_barcodes WHERE parent_code = ?', ['SHT-R']);
  assert.ok(sheet.returned_at);
  assert.equal(sheet.returned_challan_id, ret.id);

  // Cancelling the reception afterwards raises its own draft for the rest; it
  // does not hand back the sheet return.
  const cancel = await api(ctx, 'POST', `/api/challans/${inward.id}/cancel`, {});
  assert.equal(cancel.body.outcome, 'return_challan_created', JSON.stringify(cancel.body));
  assert.notEqual(cancel.body.returnChallan.id, ret.id);
  assert.equal(Number(cancel.body.returnChallan.items[0].quantity_pcs), 4);
});
