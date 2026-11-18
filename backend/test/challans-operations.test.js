const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ASKS = require('../modules/challans/asks');
const { challansClient } = require('../modules/challans/client');
const { createChallansPorts } = require('../modules/challans/ports');
const { answered, answerFile, clientFromAsks, operationsFromAsks, joinOperations } = require('../kernel/desk-kit');

// Challans behind the kernel desk.
//
// challans-routes, delivery-challans-api, challan-stock-bridge, the
// reconciliation tests and the journey tests pin every HTTP answer and every
// stock figure, and passed unchanged. This file pins what is new: a PDF and a
// JSON answer both survive the trip through a result; the keys each operation
// asks for are the gate's, odd ones included; and the neighbours' client is
// the ports, with a Map still a Map on the far side.

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-challans-ops-'));
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
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const raw = (method, route, body) =>
    fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const api = (method, route, body) =>
    raw(method, route, body).then(async (r) => ({ status: r.status, body: await r.json() }));
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await backend.saveItem({
    name: 'Challan desk part', alias: '', displayName: 'Challan desk part', groupId: group.id, unitId: unit.id, variationTree: [],
  });
  return { backend, desk: backend.desk, server, api, raw, itemId: item.id };
}

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const draft = (ctx, challanNo) => ({
  type: 'delivery',
  challanNo,
  date: '2026-08-26',
  status: 'draft',
  customerName: 'Walk-in Customer',
  maintainStocks: false,
  items: [{ itemId: ctx.itemId, variationLeafNodeId: 0, particulars: 'Test line', quantityPcs: '5', weight: '10', lineNo: 1 }],
});

test('the neighbours’ client is the ports, and a Map is still a Map on the far side', async () => {
  const ports = createChallansPorts({ get: async () => null, all: async () => [], service: {} });
  const shape = (object) =>
    Object.fromEntries(Object.entries(object).map(([key, value]) =>
      [key, typeof value === 'function' ? 'fn' : Object.keys(value).sort()]));
  assert.deepEqual(shape(challansClient({ ask: async () => ({ value: null }) })), shape(ports));

  // Through real operations: the Map crosses as pairs and comes back a Map.
  const fake = { vendorUsageCounts: async () => new Map([[3, 2], [9, 1]]), stageNotes: { find: async (ref) => ({ ref }) } };
  const asks = ASKS.filter((ask) => ['vendorUsageCounts', 'stageNotes.find'].includes(ask.port));
  const operations = operationsFromAsks('challans', asks, fake);
  const crossed = await operations['challans.vendorUsageCounts'].run({});
  assert.deepEqual(crossed, { ok: true, value: [[3, 2], [9, 1]] });
  assert.equal(JSON.stringify(crossed), '{"ok":true,"value":[[3,2],[9,1]]}', 'plain data, nothing lost in transit');
  const client = clientFromAsks('challans', asks, {
    ask: async (name, input) => operations[name].run(input),
  });
  const counts = await client.vendorUsageCounts();
  assert.ok(counts instanceof Map);
  assert.equal(counts.get(3), 2);
  assert.deepEqual(await client.stageNotes.find('run:1'), { ref: 'run:1' });

  // Two operations with one name are refused, not merged.
  assert.throws(() => joinOperations({ 'a.b': {} }, { 'a.b': {} }), /named twice: a\.b/);
});

test('a PDF answer is a result that carries the file', () => {
  const result = answered(answerFile('application/pdf', 'inline; filename="x.pdf"', Buffer.from('%PDF')));
  assert.equal(result.ok, true);
  assert.equal(result.file.contentType, 'application/pdf');
  assert.equal(result.file.disposition, 'inline; filename="x.pdf"');
  assert.equal(result.file.buffer.toString(), '%PDF');
});

test('a challan is the same through the desk and over HTTP, PDF included', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const made = await ctx.desk.call('challans.create', { data: draft(ctx, 'DESK-1') }, system);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.httpStatus, 201);
  const id = made.data.id;

  // Both spellings of the path reach the same operation.
  const one = await ctx.api('GET', `/api/challans/${id}`);
  const other = await ctx.api('GET', `/api/delivery-challans/${id}`);
  const viaDesk = await ctx.desk.call('challans.get', { id }, system);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.data, plain(viaDesk.data));
  assert.deepEqual(other.body, one.body);

  const listHttp = await ctx.api('GET', '/api/challans');
  const listDesk = await ctx.desk.call('challans.list', {}, system);
  assert.deepEqual(listHttp.body.data, plain(listDesk.data));

  // A refusal keeps its status and every field the route sent.
  const missing = await ctx.api('GET', '/api/challans/999999');
  const missingDesk = await ctx.desk.call('challans.get', { id: 999999 }, system);
  assert.equal(missing.status, missingDesk.status);
  const { ok, status, ...fields } = missingDesk;
  assert.deepEqual(missing.body, { success: false, ...plain(fields) });

  // A print preview is a PDF both ways.
  const pdf = await ctx.raw('GET', `/api/challans/${id}/print-template-preview`);
  if (pdf.status === 200) {
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    const pdfDesk = await ctx.desk.call('challans.printPreview', { id, query: {} }, system);
    assert.equal(pdfDesk.file.contentType, 'application/pdf');
    assert.equal(pdfDesk.file.buffer.subarray(0, 4).toString(), '%PDF');
  } else {
    // No template applies to this challan: the refusal is the same both ways.
    const refused = await ctx.desk.call('challans.printPreview', { id, query: {} }, system);
    assert.equal(refused.status, pdf.status);
  }

  const gone = await ctx.desk.call('challans.delete', { id }, system);
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal((await ctx.api('GET', `/api/challans/${id}`)).status, 404);
});

test('each operation asks for the key the gate asks on its path', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  const key = (name) => listed[name].permission;
  // What a reader would guess.
  assert.equal(key('challans.list'), 'challans.read');
  assert.equal(key('challans.update'), 'challans.update');
  assert.equal(key('challans.delete'), 'challans.delete');
  // What the gate actually asks, because it goes by method and first segment.
  assert.equal(key('challans.issue'), 'challans.create');
  assert.equal(key('challans.cancel'), 'challans.create');
  assert.equal(key('challans.print'), 'challans.create');
  assert.equal(key('challans.reports.clientStatement'), 'challans.create');
  assert.equal(key('challans.reconcile'), 'challans.reconcile');
  assert.equal(key('challans.listForOrder'), 'orders.read');
  assert.equal(key('challans.reports.orderReconciliation'), 'orders.read');
  assert.equal(key('challans.cancelOptions'), 'challans.read');

  const as = (permissions) => ({ actor: { kind: 'user', user: { id: 80, role: 'user', name: 'Tester' }, permissions } });
  const made = await ctx.desk.call('challans.create', { data: draft(ctx, 'DESK-2') }, system);
  const id = made.data.id;
  assert.equal((await ctx.desk.call('challans.get', { id }, as({}))).code, 'forbidden');
  assert.equal((await ctx.desk.call('challans.get', { id }, as({ 'challans.read': true }))).ok, true);
  assert.equal((await ctx.desk.call('challans.issue', { id }, as({ 'challans.update': true }))).code, 'forbidden');
  assert.equal((await ctx.desk.call('challans.reconcile', { id }, as({ 'challans.create': true }))).code, 'forbidden');
  assert.equal((await ctx.desk.call('challans.listForOrder', { orderId: 1 }, as({ 'challans.read': true }))).code, 'forbidden');
});

test('challans asks its neighbours at the desk, and they ask it, for what each declared', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  // The vendor master counts its challans through the client.
  const vendor = (await ctx.api('POST', '/api/vendors', { name: 'Counted Vendor' })).body.vendor;
  const forVendors = challansClient(ctx.desk.as('vendors'));
  assert.equal(await forVendors.vendorUsageCount(vendor.id), 0);
  assert.ok((await forVendors.vendorUsageCounts()) instanceof Map);
  assert.deepEqual(await forVendors.vendorPurchaseRows(vendor.id), []);
  await assert.rejects(forVendors.stageNotes.remove(1), (error) => error.code === 'not_declared');
  await assert.rejects(
    challansClient(ctx.desk.as('clients')).vendorUsageCount(vendor.id),
    (error) => error.code === 'not_declared',
  );

  // Challans asks orders, production, items and units instead of reading them.
  const forChallans = ctx.desk.as('challans');
  assert.deepEqual((await forChallans.ask('orders.rows.byIds', { ids: [] })).rows, []);
  assert.deepEqual((await forChallans.ask('orders.rows.forOrderNo', { orderNo: 'NO-SUCH' })).rows, []);
  assert.equal((await forChallans.ask('orders.rows.get', { id: 999999 })).row, undefined);
  assert.equal((await forChallans.ask('production.output.row', { productionRunId: 999999 })).row, undefined);
  assert.equal((await forChallans.ask('items.rows.get', { id: ctx.itemId })).row.id, ctx.itemId);
  assert.equal((await forChallans.call('people.employees.list', {})).code, 'not_declared');

  // A line delivered against an order line carries that client's GST number,
  // which used to come from a join and now comes from two asks.
  const madeClient = await ctx.api('POST', '/api/clients', { name: 'Gst Client', gstNumber: '29ZZDSK9876Q1Z7' });
  assert.equal(madeClient.status, 201, JSON.stringify(madeClient.body));
  const client = madeClient.body.client;
  const order = await ctx.api('POST', '/api/orders', {
    orderNo: 'GST-1', clientId: client.id, itemId: ctx.itemId, variationLeafNodeId: 0,
    variationPathNodeIds: [], quantity: 3, status: 'notStarted',
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const challan = await ctx.api('POST', '/api/challans', {
    ...draft(ctx, 'GST-CH-1'),
    // With stock maintained, the customer and GST number come from the order.
    maintainStocks: true,
    orderId: order.body.order.id,
    orderIds: [order.body.order.id],
    items: [{
      itemId: ctx.itemId, variationLeafNodeId: 0, particulars: 'Test line', quantityPcs: '1', weight: '1', lineNo: 1,
      orderItemId: order.body.order.id,
    }],
  });
  assert.equal(challan.status, 201, JSON.stringify(challan.body));
  const read = await ctx.api('GET', `/api/challans/${challan.body.data.id}`);
  assert.equal(read.status, 200);
  assert.ok(JSON.stringify(read.body).includes('29ZZDSK9876Q1Z7'), 'the client’s GST number is on the challan');

  const broken = Object.entries(ctx.desk.violationCounts()).filter(([name]) => name.startsWith('challans.'));
  assert.deepEqual(broken, []);
});
