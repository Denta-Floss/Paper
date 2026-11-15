const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// What an order sees of its production runs. The link from a run to the order
// lines it makes is production's; orders, the reports and inventory ask for it
// through production's port. These pin what they get: an order line's status
// as its runs tell it, the order's runs and reports, and what deleting an
// order line does to its runs and the stock they took.

async function boot() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-order-links-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'orderlinks@example.test';
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
    body: JSON.stringify({ email: 'orderlinks@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) => fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const template = await backend.get('SELECT * FROM pipeline_templates LIMIT 1');
  // A line with no runs yet, so its status starts as its own.
  const line = await backend.get(
    `SELECT oi.* FROM order_items oi
      WHERE NOT EXISTS (SELECT 1 FROM order_pipeline_assignments a WHERE a.order_item_id = oi.id)
      ORDER BY oi.id LIMIT 1`);
  assert.ok(line, 'the demo seed has an order line with no run');
  return { backend, server, api, template, line };
}

// The list answer is cached per URL until a write goes through the API. These
// tests move a run's state with SQL, so every read uses a URL of its own.
let readNo = 0;
const listed = async (ctx) => {
  readNo += 1;
  const res = await ctx.api('GET', `/api/orders?ids=${ctx.line.id}&read=${readNo}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.orders || res.body.data || [];
  return rows.find((o) => Number(o.id) === ctx.line.id);
};

// One order line read on its own: GET /api/orders/:id.
let singleNo = 0;
const single = async (ctx) => {
  singleNo += 1;
  const res = await ctx.api('GET', `/api/orders/${ctx.line.id}?read=${singleNo}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.order || res.body.data || res.body;
};

// The rule, in one place: what an order line shows, given the status someone
// set by hand and what its runs say.
//   completed  if it was marked completed, or every run is completed
//   delayed    otherwise, if it was marked delayed
//   otherwise  whichever is further along: draft < notStarted < inProgress
// A run moves a line forward and never back. With no runs, the hand-set status.
const RULE = [
  // stored        runs           shown
  ['draft',        'none',        'draft'],
  ['draft',        'notStarted',  'notStarted'],
  ['draft',        'inProgress',  'inProgress'],
  ['draft',        'completed',   'completed'],
  ['notStarted',   'none',        'notStarted'],
  ['notStarted',   'inProgress',  'inProgress'],
  ['notStarted',   'oneOfTwo',    'inProgress'],
  ['inProgress',   'notStarted',  'inProgress'],
  ['inProgress',   'completed',   'completed'],
  ['delayed',      'none',        'delayed'],
  ['delayed',      'notStarted',  'delayed'],
  ['delayed',      'inProgress',  'delayed'],
  ['delayed',      'completed',   'completed'],
  ['completed',    'none',        'completed'],
  ['completed',    'inProgress',  'completed'],
];

test('an order line shows one status, by one rule, in the list and on its own', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, backend, template, line } = ctx;
  const runA = (await api('POST', '/runs', { templateId: template.id, name: 'Rule A', orderItemId: line.id })).body.run;
  const runB = (await api('POST', '/runs', { templateId: template.id, name: 'Rule B', orderItemId: line.id })).body.run;
  const link = (runId, on) => (on
    ? backend.run('INSERT OR IGNORE INTO order_pipeline_assignments (order_item_id, pipeline_run_id) VALUES (?, ?)', [line.id, runId])
    : backend.run('DELETE FROM order_pipeline_assignments WHERE order_item_id = ? AND pipeline_run_id = ?', [line.id, runId]));
  const setRun = (runId, status, started) => backend.run(
    'UPDATE pipeline_runs SET status = ?, started_at = ? WHERE id = ?',
    [status, started ? new Date().toISOString() : null, runId]);
  const arrange = async (stored, runs) => {
    await backend.run('UPDATE order_items SET status = ? WHERE id = ?', [stored, line.id]);
    await link(runA.id, runs !== 'none');
    await link(runB.id, runs === 'oneOfTwo');
    if (runs === 'notStarted') await setRun(runA.id, 'planned', false);
    if (runs === 'inProgress') await setRun(runA.id, 'in_progress', true);
    if (runs === 'completed') await setRun(runA.id, 'completed', true);
    if (runs === 'oneOfTwo') { await setRun(runA.id, 'completed', true); await setRun(runB.id, 'planned', false); }
  };

  for (const [stored, runs, shown] of RULE) {
    await arrange(stored, runs);
    const inList = await listed(ctx);
    const alone = await single(ctx);
    const where = `stored ${stored}, runs ${runs}`;
    assert.equal(inList.status, shown, `list: ${where}`);
    assert.equal(alone.status, shown, `single order: ${where}`);
    assert.equal(inList.runStatus ?? null, runs === 'none' ? null : inList.runStatus, where);
    if (runs === 'none') assert.equal(inList.runStatus ?? null, null, `no runs, no run status: ${where}`);
  }

  // The filter, the search and the count all go by the status that is shown.
  await arrange('draft', 'inProgress');
  const rows = (res) => res.body.orders || res.body.data;
  assert.equal(rows(await api('GET', `/api/orders?status=inProgress&ids=${line.id}`)).length, 1);
  assert.equal(rows(await api('GET', `/api/orders?status=draft&ids=${line.id}`)).length, 0);
  assert.ok(rows(await api('GET', '/api/orders?search=inprogress')).some((o) => Number(o.id) === line.id));
  const paged = await api('GET', '/api/orders?status=inProgress&limit=1&offset=0');
  const all = rows(await api('GET', '/api/orders?status=inProgress'));
  assert.equal(paged.body.total ?? paged.body.meta?.total, all.length, 'the count is of the same narrowing');

  // A status can still be set by hand on a line whose runs are ahead of it:
  // the move is checked against what was set by hand, not what is shown.
  await arrange('notStarted', 'completed');
  const byHand = await api('PATCH', `/api/orders/${line.id}/lifecycle`, { status: 'inProgress' });
  assert.ok(byHand.status < 300, JSON.stringify(byHand.body));
  const storedNow = await backend.get('SELECT status FROM order_items WHERE id = ?', [line.id]);
  assert.equal(storedNow.status, 'inProgress');
  assert.equal((await listed(ctx)).status, 'completed', 'and the runs still show it completed');
});

test('a run moving tells the app its order line changed', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, backend, template, line } = ctx;
  await backend.run("UPDATE order_items SET status = 'draft' WHERE id = ?", [line.id]);
  const changes = async () => (await backend.get(
    "SELECT COUNT(*) AS c FROM changelog WHERE table_name = 'order_items' AND record_id = ?", [String(line.id)])).c
    + (await backend.get(
      "SELECT COUNT(*) AS c FROM changelog WHERE table_name = 'order_items' AND record_id = ?", [line.id])).c;
  const plain = async () => {
    const res = await api('GET', `/api/orders?ids=${line.id}`);
    return (res.body.orders || res.body.data)[0].status;
  };

  let before = await changes();
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Announce', orderItemId: line.id })).body.run;
  assert.ok(await changes() > before, 'starting a run for the line announces the line');
  assert.notEqual(await plain(), 'draft', 'and the list already shows it moved');

  before = await changes();
  const nodes = JSON.parse(template.nodes_json || '[]');
  for (const node of nodes) {
    await api('PUT', `/runs/${run.id}/node-status`, { nodeId: node.id, status: 'done' });
  }
  assert.ok(await changes() > before, 'completing the run announces the line');
  assert.equal(await plain(), 'completed');

  before = await changes();
  assert.equal((await api('DELETE', `/runs/${run.id}`)).status, 200);
  assert.ok(await changes() > before, 'removing the run announces the line');
});

test("an order's runs and reports are read through its lines", async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, template, line } = ctx;
  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Report Link', orderItemId: line.id })).body.run;
  const orderNo = encodeURIComponent(line.order_no);

  const runs = await api('GET', `/api/orders/${orderNo}/pipeline-runs`);
  assert.equal(runs.status, 200, JSON.stringify(runs.body));
  assert.equal(runs.body.runs.filter((r) => r.id === run.id).length, 1);
  assert.equal(runs.body.runs.find((r) => r.id === run.id).orderNo, line.order_no);

  for (const report of ['production-report', 'trace', 'reconciliation']) {
    const res = await api('GET', `/api/orders/${orderNo}/${report}`);
    assert.equal(res.status, 200, `${report}: ${JSON.stringify(res.body).slice(0, 300)}`);
    assert.equal(res.body.success, true, report);
    assert.ok(JSON.stringify(res.body).includes(run.id), `${report} names the order's run`);
  }
  const fulfilment = await api('GET', '/api/orders/fulfilment');
  assert.equal(fulfilment.status, 200, JSON.stringify(fulfilment.body).slice(0, 300));
});

test('deleting an order line dissolves its runs and puts back what they took', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { api, backend, template, line } = ctx;

  const vendor = (await api('POST', '/api/vendors', { name: 'Link Vendor' })).body.vendor;
  const leaf = await backend.get(
    `SELECT n.id, n.item_id FROM item_variation_nodes n
      WHERE n.kind = 'value' AND n.is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM item_variation_nodes c WHERE c.parent_node_id = n.id AND c.is_archived = 0)
      LIMIT 1`);
  const reception = (await api('POST', '/api/challans', {
    type: 'reception', challanNo: 'OL-REC-1', date: '2026-11-15', status: 'draft', maintainStocks: true,
    vendorId: vendor.id, vendorName: vendor.name, purpose: 'purchase',
    items: [{ itemId: leaf.item_id, variationLeafNodeId: leaf.id, particulars: 'Stock', quantityPcs: '9', lineNo: 1 }],
  })).body.data;
  assert.equal((await api('POST', `/api/challans/${reception.id}/issue`, {})).status, 200);
  const onHand = async () => (await backend.get(
    "SELECT COALESCE(SUM(on_hand_qty), 0) AS q FROM inventory_stock_positions WHERE material_barcode = 'OL-REC-1-L1'")).q;

  const run = (await api('POST', '/runs', { templateId: template.id, name: 'Dissolve Link', orderItemId: line.id })).body.run;
  const put = await api('POST', `/runs/${run.id}/barcodes`, { nodeId: 'node-1', barcode: 'OL-REC-1-L1', quantity: 4 });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(await onHand(), 5);

  const gone = await api('DELETE', `/api/orders/${line.id}`, {});
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(await onHand(), 9, 'the stock the run took is back');
  assert.equal(await backend.get('SELECT id FROM pipeline_runs WHERE id = ?', [run.id]), undefined);
  assert.equal((await backend.get('SELECT COUNT(*) AS c FROM run_barcode_inputs WHERE run_id = ?', [run.id])).c, 0);
  assert.equal((await backend.get('SELECT COUNT(*) AS c FROM order_pipeline_assignments WHERE order_item_id = ?', [line.id])).c, 0);
});
