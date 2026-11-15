const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Stock put on a production run node by QUANTITY rather than by scanning one
// barcode. Stock of one item and variation can sit under several barcodes (one
// per reception line), so a quantity has to say which of them it comes from:
// the server lists them by name with a proposal, oldest first, and takes stock
// only for a split somebody approved.

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-run-stock-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'runstock@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'runstock@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) => fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const item = await backend.get('SELECT * FROM items LIMIT 1');
  const leaf = await backend.get(
    `SELECT n.* FROM item_variation_nodes n
      WHERE n.item_id = ? AND n.kind = 'value' AND n.is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM item_variation_nodes c WHERE c.parent_node_id = n.id AND c.is_archived = 0)
      LIMIT 1`,
    [item.id],
  );
  const vendor = (await api('POST', '/api/vendors', { name: 'Run Stock Vendor' })).body.vendor;
  const receive = async (challanNo, qty) => {
    const made = await api('POST', '/api/challans', {
      type: 'reception', challanNo, date: '2026-11-15', status: 'draft', maintainStocks: true,
      vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase',
      items: [{ itemId: item.id, variationLeafNodeId: leaf.id, particulars: `Lot ${challanNo}`, quantityPcs: String(qty), lineNo: 1 }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await api('POST', `/api/challans/${made.body.data.id}/issue`, {})).status, 200);
    // Receptions made in the same second must still come out oldest first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return made.body.data;
  };
  const template = await backend.get('SELECT * FROM pipeline_templates LIMIT 1');
  const runId = (await api('POST', '/runs', { templateId: template.id, name: 'Run Stock' })).body.run.id;
  const position = async (barcode) => (await backend.get(
    'SELECT COALESCE(SUM(on_hand_qty), 0) AS q FROM inventory_stock_positions WHERE material_barcode = ?', [barcode])).q;
  const stock = async () => (await backend.get(
    'SELECT COALESCE(SUM(quantity), 0) AS q FROM variation_stock WHERE item_id = ? AND variation_leaf_node_id = ?',
    [item.id, leaf.id])).q;
  return { backend, server, api, item, leaf, receive, runId, position, stock };
}

test('the barcodes that hold an item are listed by name, oldest first, with a proposal', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await ctx.receive('RS-A', 5);
  await ctx.receive('RS-B', 4);

  const res = await ctx.api('GET', `/api/inventory/stock-sources?itemId=${ctx.item.id}&variationLeafNodeId=${ctx.leaf.id}&quantity=7`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mine = res.body.sources.filter((s) => s.barcode.startsWith('RS-'));
  assert.deepEqual(mine.map((s) => s.barcode), ['RS-A-L1', 'RS-B-L1']);
  assert.equal(mine[0].name, 'Lot RS-A');
  assert.equal(mine[0].supplier, 'Run Stock Vendor');
  assert.equal(mine[0].receptionChallanNo, 'RS-A');
  assert.equal(mine[0].free, 5);
  assert.equal(mine[1].free, 4);
  assert.equal(res.body.totalFree, res.body.sources.reduce((sum, s) => sum + s.free, 0));
  const proposed = res.body.proposal.reduce((sum, p) => sum + p.quantity, 0);
  assert.equal(proposed, 7, 'the proposal covers the quantity');
  assert.equal(res.body.proposal[0].barcode, res.body.sources[0].barcode, 'starting with the oldest');
});

test('a quantity is not taken until someone says which barcodes it comes from', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  await ctx.receive('RS-C', 5);
  await ctx.receive('RS-D', 4);
  const before = await ctx.stock();
  const ask = { nodeId: 'node-1', itemId: ctx.item.id, variationLeafNodeId: ctx.leaf.id, quantity: 7 };

  const unapproved = await ctx.api('POST', `/runs/${ctx.runId}/barcodes`, ask);
  assert.equal(unapproved.status, 409, JSON.stringify(unapproved.body));
  assert.equal(unapproved.body.code, 'allocation_required');
  assert.ok(unapproved.body.sources.some((s) => s.barcode === 'RS-C-L1' && s.name === 'Lot RS-C'));
  assert.ok(unapproved.body.proposal.length > 0);
  assert.equal(await ctx.stock(), before, 'nothing moved');

  // A split that does not add up, takes more than a barcode has, or names a
  // barcode of something else is refused whole.
  for (const allocations of [
    [{ barcode: 'RS-C-L1', quantity: 5 }, { barcode: 'RS-D-L1', quantity: 1 }],
    [{ barcode: 'RS-C-L1', quantity: 6 }, { barcode: 'RS-D-L1', quantity: 1 }],
    [{ barcode: 'RS-C-L1', quantity: 5 }, { barcode: 'NOT-A-BARCODE', quantity: 2 }],
    [{ barcode: 'RS-C-L1', quantity: 3.5 }, { barcode: 'RS-C-L1', quantity: 3.5 }],
  ]) {
    const bad = await ctx.api('POST', `/runs/${ctx.runId}/barcodes`, { ...ask, allocations });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'invalid_allocation');
  }
  assert.equal(await ctx.position('RS-C-L1'), 5);
  assert.equal(await ctx.position('RS-D-L1'), 4);
  assert.equal((await ctx.backend.get('SELECT COUNT(*) AS c FROM run_barcode_inputs WHERE run_id = ?', [ctx.runId])).c, 0);

  // Approved: stock comes off exactly those barcodes.
  const approved = await ctx.api('POST', `/runs/${ctx.runId}/barcodes`, {
    ...ask,
    allocations: [{ barcode: 'RS-C-L1', quantity: 5 }, { barcode: 'RS-D-L1', quantity: 2 }],
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(await ctx.position('RS-C-L1'), 0);
  assert.equal(await ctx.position('RS-D-L1'), 2);
  assert.equal(await ctx.stock(), before - 7, 'and the item has 7 fewer, once');
  const rows = await ctx.backend.all(
    'SELECT barcode, source_kind, consumed_qty FROM run_barcode_inputs WHERE run_id = ? ORDER BY barcode', [ctx.runId]);
  assert.deepEqual(rows.map((r) => [r.barcode, r.source_kind, r.consumed_qty]), [
    ['RS-C-L1', 'barcode', 5],
    ['RS-D-L1', 'barcode', 2],
  ]);
  const consumes = await ctx.backend.all(
    "SELECT material_barcode, qty FROM inventory_movements WHERE movement_type = 'consume' AND reference_id = ? ORDER BY material_barcode",
    [String(ctx.runId)]);
  assert.deepEqual(consumes.map((m) => [m.material_barcode, m.qty]), [['RS-C-L1', 5], ['RS-D-L1', 2]]);

  // Each barcode can then be taken back off the run on its own.
  const removed = await ctx.api('DELETE', `/runs/${ctx.runId}/barcodes/node-1/RS-D-L1`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await ctx.position('RS-D-L1'), 4);
  assert.equal(await ctx.stock(), before - 5);
});

test('with no barcode holding it, a quantity comes off the item itself and goes back when removed', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  // Stock that is only a figure on the item: no material stands behind it.
  await ctx.backend.run('DELETE FROM materials WHERE linked_item_id = ?', [ctx.item.id]);
  await ctx.backend.run('DELETE FROM variation_stock WHERE item_id = ?', [ctx.item.id]);
  await ctx.backend.run(
    "INSERT INTO variation_stock (item_id, variation_leaf_node_id, quantity, location_id) VALUES (?, ?, 10, 'MAIN')",
    [ctx.item.id, ctx.leaf.id]);
  const ask = { nodeId: 'node-1', itemId: ctx.item.id, variationLeafNodeId: ctx.leaf.id };

  const tooMuch = await ctx.api('POST', `/runs/${ctx.runId}/barcodes`, { ...ask, quantity: 11 });
  assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.body));
  assert.equal(await ctx.stock(), 10);

  const taken = await ctx.api('POST', `/runs/${ctx.runId}/barcodes`, { ...ask, quantity: 4 });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(await ctx.stock(), 6);
  const row = await ctx.backend.get('SELECT * FROM run_barcode_inputs WHERE run_id = ?', [ctx.runId]);
  assert.equal(row.source_kind, 'quantity');
  assert.equal(row.consumed_qty, 4);

  const changed = await ctx.api('PUT', `/runs/${ctx.runId}/barcodes`, { nodeId: 'node-1', barcode: row.barcode, quantity: 7 });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(await ctx.stock(), 3);

  const removed = await ctx.api('DELETE', `/runs/${ctx.runId}/barcodes`, { nodeId: 'node-1', barcode: row.barcode });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await ctx.stock(), 10);
});
