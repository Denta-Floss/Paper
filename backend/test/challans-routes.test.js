const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The challan routes nothing else reaches over HTTP: update, cancel and its
// options, report groups, print, delete, piece barcodes, the order's challan
// list, invoices, the reconciliation reports, and challan templates.
// delivery-challans-api.test.js covers the same code as function calls; this
// file is about the routes, written before they leave server.js.
//
// It also records four things that are broken today, exactly as they are, so
// the move cannot change them by accident and a later fix flips them visibly.

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
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-challans-routes-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'challans@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'challans@example.test', password: 'OwnerPass1234' }),
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

async function simpleItem(ctx, name) {
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name, alias: '', displayName: name, groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return item.id;
}

async function makeChallan(ctx, challanNo, extra = {}) {
  const itemId = extra.itemId || await simpleItem(ctx, `Item for ${challanNo}`);
  const res = await api(ctx, 'POST', '/api/challans', {
    type: 'delivery',
    challanNo,
    date: '2026-08-26',
    status: 'draft',
    customerName: 'Walk-in Customer',
    maintainStocks: false,
    items: [{ itemId, variationLeafNodeId: 0, particulars: 'Test line', quantityPcs: '5', weight: '10', lineNo: 1 }],
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('challans: both path spellings answer, and a draft can be read, edited, printed and deleted', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-CH-1');
  assert.equal(challan.status, 'draft');

  for (const base of ['/api/challans', '/api/delivery-challans']) {
    const one = await api(ctx, 'GET', `${base}/${challan.id}`);
    assert.equal(one.status, 200, base);
    assert.equal(one.body.data.challan_no ?? one.body.data.challanNo, 'RT-CH-1');
    const list = await api(ctx, 'GET', base);
    assert.equal(list.status, 200, base);
  }
  assert.equal((await api(ctx, 'GET', '/api/challans/999999')).status, 404);

  const edited = await api(ctx, 'PUT', `/api/delivery-challans/${challan.id}`, {
    type: 'delivery',
    challanNo: 'RT-CH-1',
    date: '2026-08-27',
    status: 'draft',
    customerName: 'Edited Customer',
    maintainStocks: false,
    items: [{ itemId: challan.items[0].item_id ?? challan.items[0].itemId, variationLeafNodeId: 0, particulars: 'Edited line', quantityPcs: '7', weight: '14', lineNo: 1 }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.customer_name ?? edited.body.data.customerName, 'Edited Customer');
  assert.equal(edited.body.data.items[0].particulars, 'Edited line');
  assert.ok(Array.isArray(edited.body.warnings));

  const printed = await api(ctx, 'POST', `/api/challans/${challan.id}/print`, {});
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.equal((await api(ctx, 'POST', '/api/challans/999999/print', {})).status, 404);

  const byOrder = await api(ctx, 'GET', '/api/orders/999999/delivery-challans');
  assert.equal(byOrder.status, 200);

  const gone = await api(ctx, 'DELETE', `/api/challans/${challan.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal((await api(ctx, 'GET', `/api/challans/${challan.id}`)).status, 404);
});

test('challans: issue, cancel options and cancel; an issued challan cannot be deleted as a draft', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-CH-2');

  const issued = await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.data.status, 'issued');

  const notDraft = await api(ctx, 'DELETE', `/api/challans/${challan.id}`);
  assert.ok(notDraft.status >= 400, 'only a draft is deleted outright');

  const options = await api(ctx, 'GET', `/api/challans/${challan.id}/cancel-options`);
  assert.equal(options.status, 200);
  assert.deepEqual(options.body.linkedInvoices, []);
  assert.deepEqual(options.body.availableActions.map((a) => a.key), ['block']);

  const cancelled = await api(ctx, 'POST', `/api/delivery-challans/${challan.id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, 'cancelled');
});

test('challans: a challan with an invoice is not cancelled until the invoice is dealt with', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-CH-3');
  await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});

  const invoice = await api(ctx, 'POST', '/api/invoices', {
    clientId: null,
    lines: [{ challanId: challan.id, particulars: 'Billed', quantity: 2, rate: 50 }],
  });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

  const options = await api(ctx, 'GET', `/api/challans/${challan.id}/cancel-options`);
  assert.equal(options.body.linkedInvoices.length, 1);

  const blocked = await api(ctx, 'POST', `/api/challans/${challan.id}/cancel`, { action: 'block' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /linked invoices/);
  const junk = await api(ctx, 'POST', `/api/challans/${challan.id}/cancel`, { action: 'whatever' });
  assert.equal(junk.status, 400);
});

test('challans: report groups, and piece barcodes that must belong to the challan', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-CH-4', { type: 'reception', vendorId: null });

  const groups = await api(ctx, 'PATCH', `/api/challans/${challan.id}/report-groups`, { reportGroupCodes: ['a1', 'b2'] });
  assert.equal(groups.status, 200, JSON.stringify(groups.body));
  assert.equal((await api(ctx, 'PATCH', '/api/challans/999999/report-groups', { reportGroupCodes: [] })).status, 404);

  assert.equal((await api(ctx, 'POST', '/api/challans/0/piece-barcodes', { barcodes: [] })).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/challans/999999/piece-barcodes', { barcodes: [] })).status, 404);
  const foreign = await api(ctx, 'POST', `/api/challans/${challan.id}/piece-barcodes`, {
    barcodes: [{ challanItemId: 999999, barcode: 'X-1' }],
  });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /not part of challan/);
  const empty = await api(ctx, 'POST', `/api/challans/${challan.id}/piece-barcodes`, { barcodes: [] });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
});

test('invoices: list, read, pdf, status and delete', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-INV-1');
  await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  const made = await api(ctx, 'POST', '/api/invoices', {
    clientId: null,
    lines: [{ challanId: challan.id, particulars: 'Line one', quantity: 2, rate: 50 }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const invoice = made.body.invoice || made.body.data;
  assert.ok(invoice && invoice.id, JSON.stringify(Object.keys(made.body)));

  const list = await api(ctx, 'GET', '/api/invoices');
  assert.equal(list.status, 200);
  const one = await api(ctx, 'GET', `/api/invoices/${invoice.id}`);
  assert.equal(one.status, 200);
  assert.equal((await api(ctx, 'GET', '/api/invoices/999999')).status, 404);

  const pdf = await fetch(`${ctx.baseUrl}/api/invoices/${invoice.id}/pdf`, { headers: ctx.headers });
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.ok((await pdf.arrayBuffer()).byteLength > 500);

  const status = await api(ctx, 'PATCH', `/api/invoices/${invoice.id}/status`, { status: 'issued' });
  assert.ok([200, 400].includes(status.status), JSON.stringify(status.body));

  const fresh = await api(ctx, 'POST', '/api/invoices', {
    clientId: null,
    lines: [{ challanId: challan.id, particulars: 'To delete', quantity: 1, rate: 10 }],
  });
  const freshId = (fresh.body.invoice || fresh.body.data).id;
  const gone = await api(ctx, 'DELETE', `/api/invoices/${freshId}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal((await api(ctx, 'GET', `/api/invoices/${freshId}`)).status, 404);
});

test('reports: reconciliation report, conversion overrides, waste audit and client statement answer', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const report = await api(ctx, 'GET', '/api/reconciliation/report');
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 300));
  const overrides = await api(ctx, 'GET', '/api/reconciliation/conversion-overrides');
  assert.equal(overrides.status, 200);
  const waste = await api(ctx, 'GET', '/api/reconciliation/waste-audit');
  assert.equal(waste.status, 200);
  const badOverride = await api(ctx, 'PATCH', '/api/reconciliation/conversion-overrides', {});
  assert.ok(badOverride.status >= 400);
  const statement = await api(ctx, 'POST', '/api/reports/client-statement', {});
  assert.ok([200, 400].includes(statement.status), JSON.stringify(statement.body).slice(0, 300));
  const orderRecon = await api(ctx, 'GET', '/api/orders/NO-SUCH-ORDER/reconciliation');
  assert.equal(orderRecon.status, 404);
});

test('templates: list, scans (which must not be read as an id), one, and the refusals', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const list = await api(ctx, 'GET', '/api/challan-templates');
  assert.equal(list.status, 200);
  // Registered before /:id on purpose; if the order ever flips this is a 404.
  const scans = await api(ctx, 'GET', '/api/challan-templates/scans');
  assert.equal(scans.status, 200, JSON.stringify(scans.body));
  assert.equal((await api(ctx, 'GET', '/api/challan-templates/999999')).status, 404);
  assert.ok((await api(ctx, 'POST', '/api/challan-templates', {})).status >= 400);
  assert.ok((await api(ctx, 'PATCH', '/api/challan-templates/999999', { name: 'x' })).status >= 400);
  assert.equal((await api(ctx, 'DELETE', '/api/challan-templates/999999')).status, 404);
  assert.ok((await api(ctx, 'POST', '/api/challan-templates/upload-intent', {})).status >= 400);
  assert.ok((await api(ctx, 'POST', '/api/challan-templates/upload-complete', {})).status >= 400);
  assert.ok((await api(ctx, 'POST', '/api/challan-templates/stamp-upload-intent', {})).status >= 400);
  assert.ok((await api(ctx, 'POST', '/api/challan-templates/stamp-upload-complete', {})).status >= 400);
  const preview = await api(ctx, 'GET', '/api/challans/999999/print-template-preview');
  assert.ok(preview.status >= 400);
  const byId = await fetch(`${ctx.baseUrl}/api/templates/999999/test-print`, { headers: ctx.headers });
  assert.ok(byId.status >= 400);
});

// ---- broken today, recorded as it is --------------------------------------

test('KNOWN BUG: GET /api/challan-templates/test-print is answered by /:id and never runs', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const res = await api(ctx, 'GET', '/api/challan-templates/test-print');
  assert.equal(res.status, 404, 'test-print is read as a template id');
});

test('invoices: an edit replaces the lines and recomputes the totals', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-INV-EDIT');
  await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  const made = await api(ctx, 'POST', '/api/invoices', {
    clientId: null,
    lines: [{ challanId: challan.id, itemName: 'Line one', quantity: 2, unitPrice: 50 }],
  });
  const invoice = made.body.invoice || made.body.data;

  // This always failed before ("prepare is not defined").
  const edited = await api(ctx, 'PUT', `/api/invoices/${invoice.id}`, {
    clientId: null,
    clientName: 'Edited Buyer',
    lines: [
      { challanId: challan.id, itemName: 'Line one, edited', quantity: 3, unitPrice: 50, cgstRate: 9, sgstRate: 9 },
      { challanId: challan.id, itemName: 'A second line', quantity: 1, unitPrice: 20 },
    ],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const lines = await ctx.backend.all('SELECT item_name, quantity FROM invoice_lines WHERE invoice_id = ? ORDER BY id', [invoice.id]);
  assert.deepEqual(lines.map((l) => l.item_name), ['Line one, edited', 'A second line'], 'the old line is gone, the new two are there');
  const header = await ctx.backend.get('SELECT * FROM invoice_headers WHERE id = ?', [invoice.id]);
  assert.equal(header.client_name, 'Edited Buyer');
  assert.equal(header.total_quantity, 4);
  assert.equal(header.taxable_value, 170);
  assert.equal(header.cgst_amount, 13.5);
  assert.equal(header.total_amount, 197);

  // An edit that is refused changes nothing.
  const empty = await api(ctx, 'PUT', `/api/invoices/${invoice.id}`, { lines: [] });
  assert.equal(empty.status, 500);
  assert.match(empty.body.error, /at least one invoice line/);
  const still = await ctx.backend.get('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id = ?', [invoice.id]);
  assert.equal(still.c, 2);

  // And an invoice that is not there is a 404, not a set of orphan lines.
  const ghost = await api(ctx, 'PUT', '/api/invoices/999999', {
    lines: [{ itemName: 'Nobody', quantity: 1, unitPrice: 1 }],
  });
  assert.equal(ghost.status, 404);
  const orphans = await ctx.backend.get('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id = 999999');
  assert.equal(orphans.c, 0);
});

test('KNOWN BUG: completing a challan photo upload always fails once it is valid', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-BUG-ASSET');
  const res = await api(ctx, 'POST', `/api/delivery-challans/${challan.id}/assets/upload-complete`, {
    uploadSessionId: 'x', objectKey: 'y',
  });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /handleAssetUploadComplete is not defined/);
});

test('settling an in-use challan puts its weight into scrap and finished-goods stock, once', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const challan = await makeChallan(ctx, 'RT-SETTLE-1', { type: 'internal', purpose: 'internal_use' });
  await api(ctx, 'POST', `/api/challans/${challan.id}/issue`, {});
  const line = (await api(ctx, 'GET', `/api/challans/${challan.id}`)).body.data.items[0];

  assert.equal((await api(ctx, 'POST', '/api/challans/999999/reconcile', {})).status, 404);
  const missing = await api(ctx, 'POST', `/api/challans/${challan.id}/reconcile`, { lines: [] });
  assert.equal(missing.status, 400);
  const unbalanced = await api(ctx, 'POST', `/api/challans/${challan.id}/reconcile`, {
    lines: [{ challanItemId: line.id, buckets: { scrap: 1 } }],
  });
  assert.equal(unbalanced.status, 400, 'the full 10 kg has to be accounted for');
  const untouched = await ctx.backend.get("SELECT COUNT(*) AS c FROM materials WHERE barcode LIKE 'LOT-RECON-%'");
  assert.equal(untouched.c, 0, 'a refused settle creates no stock');

  // This never completed before, for two reasons: the settle's transaction and
  // the item save's transaction collided, and the stock lot was written with a
  // variation leaf of 0, which is not a variation.
  const settled = await api(ctx, 'POST', `/api/challans/${challan.id}/reconcile`, {
    lines: [{ challanItemId: line.id, buckets: { finishedGoods: 6, scrap: 4 } }],
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.body).slice(0, 300));
  assert.equal(settled.body.data.status, 'completed');

  const lots = await ctx.backend.all(
    "SELECT name, on_hand_qty, linked_variation_leaf_node_id FROM materials WHERE barcode LIKE 'LOT-RECON-%' ORDER BY name",
  );
  assert.equal(lots.length, 2, 'one lot per bucket that received weight');
  assert.match(lots[0].name, /^finished_goods_/);
  assert.equal(lots[0].on_hand_qty, 6);
  assert.match(lots[1].name, /^scrap_/);
  assert.equal(lots[1].on_hand_qty, 4);
  assert.equal(lots[0].linked_variation_leaf_node_id, null);
  const items = await ctx.backend.all("SELECT name FROM items WHERE name LIKE 'scrap_%' OR name LIKE 'finished_goods_%'");
  assert.equal(items.length, 2, 'and an item for each, under the reconcile groups');

  const again = await api(ctx, 'POST', `/api/challans/${challan.id}/reconcile`, {
    lines: [{ challanItemId: line.id, buckets: { finishedGoods: 6, scrap: 4 } }],
  });
  assert.equal(again.status, 409, 'a challan is settled once');
  const after = await ctx.backend.get("SELECT COUNT(*) AS c FROM materials WHERE barcode LIKE 'LOT-RECON-%'");
  assert.equal(after.c, 2);
});
