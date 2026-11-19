const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The small masters behind the kernel desk: vendors, clients, people, machines,
// dies and pipeline templates.
//
// Their own API tests already pin every HTTP answer, and those passed unchanged
// when the routes were moved onto operations. This file pins what is new:
//
//   1. the operation and the route are the same thing asked two ways;
//   2. the neighbours that used to be handed a function now ask the desk, and
//      only for what they have declared;
//   3. ordinary use breaks none of the typed contracts, which is the evidence
//      for holding them in enforce mode later.

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
  const tempDir = makeTempDir('paper-small-masters-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'masters@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'masters@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  return {
    backend,
    desk: backend.desk,
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

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));

test('each master’s list is the same through the desk as over HTTP', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const pairs = [
    ['vendors.list', '/api/vendors', 'vendors'],
    ['clients.list', '/api/clients', 'clients'],
    ['clients.subContractors.list', '/api/sub-contractors', 'subContractors'],
    ['people.departments.list', '/api/departments', 'departments'],
    ['people.employees.list', '/api/employees', 'employees'],
    ['machines.list', '/api/machines', 'machines'],
    ['dies.list', '/api/dies', 'dies'],
    ['pipelines.templates.list', '/api/production/pipeline-templates', 'templates'],
  ];
  for (const [operation, route, key] of pairs) {
    const viaDesk = await ctx.desk.call(operation, {}, system);
    const viaHttp = await api(ctx, 'GET', route);
    assert.equal(viaDesk.ok, true, operation);
    assert.equal(viaHttp.status, 200, route);
    assert.deepEqual(viaHttp.body[key], plain(viaDesk[key]), `${operation} and ${route}`);
  }
});

test('a refusal is the same refusal with no request', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  assert.deepEqual(await ctx.desk.call('vendors.get', { id: 999999 }, system), {
    ok: false, status: 404, error: 'Not found',
  });
  assert.deepEqual(await ctx.desk.call('machines.get', { id: 'nope' }, system), {
    ok: false, status: 404, machine: null, error: 'Machine not found',
  });
  assert.deepEqual(await ctx.desk.call('dies.get', { id: 'nope' }, system), {
    ok: false, status: 404, die: null, error: 'Die not found',
  });

  // A vendor a challan names cannot be deleted, and the refusal says why.
  const vendor = (await api(ctx, 'POST', '/api/vendors', { name: 'Desk Steel' })).body.vendor;
  const twin = await ctx.desk.call('vendors.create', { name: 'desk steel' }, system);
  assert.equal(twin.ok, false);
  assert.equal(twin.status, 409);

  // A client that is on an order line stays, through either door.
  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Desk Client' })).body.client;
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await ctx.backend.get('SELECT id FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name: 'Desk part', alias: '', displayName: 'Desk part', groupId: group.id, unitId: unit.id, variationTree: [],
  });
  const order = await api(ctx, 'POST', '/api/orders', {
    orderNo: 'DESK-1', clientId: client.id, itemId: item.id, variationLeafNodeId: 0,
    variationPathNodeIds: [], quantity: 1, status: 'notStarted',
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));

  const viaDesk = await ctx.desk.call('clients.delete', { id: client.id }, system);
  const viaHttp = await api(ctx, 'DELETE', `/api/clients/${client.id}`);
  assert.equal(viaDesk.status, 409);
  assert.equal(viaDesk.code, 'client_in_use');
  assert.equal(viaHttp.status, 409);
  assert.deepEqual(viaHttp.body, { success: false, code: 'client_in_use', error: viaDesk.error });

  const archive = await ctx.desk.call('clients.archive', { id: client.id }, system);
  assert.equal(archive.status, 409);
  assert.equal(archive.code, 'client_in_use');
  assert.deepEqual(await ctx.desk.call('clients.archive', { id: 999999 }, system), {
    ok: false, status: 404, error: 'Not found', notFound: true,
  });

  assert.equal((await api(ctx, 'DELETE', `/api/vendors/${vendor.id}`)).status, 200);
});

test('neighbours ask these masters at the desk, and only for what they declared', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const vendor = (await api(ctx, 'POST', '/api/vendors', { name: 'Asked Vendor' })).body.vendor;
  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Asked Client' })).body.client;

  // Challans names the vendor of a reception and the client of an invoice.
  assert.equal((await ctx.desk.as('challans').ask('vendors.rows.get', { id: vendor.id })).row.name, 'Asked Vendor');
  assert.equal((await ctx.desk.as('challans').ask('clients.rows.get', { id: client.id })).row.name, 'Asked Client');
  // Orders needs the client a line is for; a die checks its client exists.
  assert.equal((await ctx.desk.as('orders').ask('clients.rows.get', { id: client.id })).row.id, client.id);
  assert.equal((await ctx.desk.as('dies').ask('clients.exists', { id: client.id })).exists, true);
  assert.equal((await ctx.desk.as('dies').ask('clients.exists', { id: 999999 })).exists, false);
  // Jobs finds the person a badge belongs to.
  assert.equal((await ctx.desk.as('jobs').ask('people.employees.idByBarcode', { barcodeId: 'NO-SUCH' })).employeeId, null);
  // A machine is numbered after its type, which is an item group.
  const group = await ctx.backend.get('SELECT id, name FROM groups ORDER BY id LIMIT 1');
  assert.equal((await ctx.desk.as('machines').ask('items.groups.name', { id: group.id })).name, group.name);
  assert.equal((await ctx.desk.as('machines').ask('items.groups.name', { id: 999999 })).name, null);

  // What was not declared is refused, in both directions.
  assert.equal((await ctx.desk.as('orders').call('vendors.rows.get', { id: vendor.id })).code, 'not_declared');
  assert.equal((await ctx.desk.as('vendors').call('clients.rows.get', { id: client.id })).code, 'not_declared');
  assert.equal((await ctx.desk.as('jobs').call('people.employees.delete', { id: 1 })).code, 'not_declared');

  // A die refuses a client that is not one, as it did when it read the table.
  const refused = await api(ctx, 'POST', '/api/dies', { toolCode: 'OD-1', status: 'active', ownership: 'inHouse', clientId: 999999 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'That client does not exist.');
});

test('ordinary use of the small masters breaks none of their contracts', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const ok = (res, label) => assert.ok(res.status < 300, `${label}: ${res.status} ${JSON.stringify(res.body)}`);

  // Vendors
  const vendor = await api(ctx, 'POST', '/api/vendors', {
    name: 'Contract Steel', alias: 'CS', gstNumber: '', address: 'Plot 4', contactName: 'Ravi', phone: '9000000001', email: '',
  });
  ok(vendor, 'vendor create');
  ok(await api(ctx, 'PATCH', `/api/vendors/${vendor.body.vendor.id}`, { name: 'Contract Steel', address: 'Plot 5' }), 'vendor update');
  ok(await api(ctx, 'GET', `/api/vendors/${vendor.body.vendor.id}`), 'vendor get');
  ok(await api(ctx, 'GET', `/api/vendors/${vendor.body.vendor.id}/purchase-history`), 'vendor history');
  ok(await api(ctx, 'DELETE', `/api/vendors/${vendor.body.vendor.id}`), 'vendor delete');

  // Clients and sub-contractors
  const client = await api(ctx, 'POST', '/api/clients', { name: 'Contract Client', alias: 'CC', phone: '9000000002' });
  ok(client, 'client create');
  const clientId = client.body.client.id;
  ok(await api(ctx, 'PATCH', `/api/clients/${clientId}`, { address: 'Road 1' }), 'client update');
  ok(await api(ctx, 'GET', `/api/clients/${clientId}`), 'client get');
  const sub = await api(ctx, 'POST', `/api/clients/${clientId}/sub-contractors`, { name: 'Contract Sub', phone: '9000000003' });
  ok(sub, 'sub-contractor create');
  ok(await api(ctx, 'PUT', `/api/sub-contractors/${sub.body.subContractor.id}`, { name: 'Contract Sub', notes: 'Polishing' }), 'sub-contractor update');
  ok(await api(ctx, 'GET', `/api/clients/${clientId}/sub-contractors`), 'sub-contractor list');
  ok(await api(ctx, 'DELETE', `/api/sub-contractors/${sub.body.subContractor.id}`), 'sub-contractor delete');
  ok(await api(ctx, 'PATCH', `/api/clients/${clientId}/archive`), 'client archive');
  ok(await api(ctx, 'PATCH', `/api/clients/${clientId}/unarchive`), 'client unarchive');
  ok(await api(ctx, 'DELETE', `/api/clients/${clientId}`), 'client delete');

  // People
  const dept = await api(ctx, 'POST', '/api/departments', { name: 'Contract Dept' });
  ok(dept, 'department create');
  const deptId = dept.body.department.id;
  ok(await api(ctx, 'PATCH', `/api/departments/${deptId}`, { name: 'Contract Department' }), 'department update');
  const employee = await api(ctx, 'POST', '/api/employees', { departmentId: deptId, name: 'Contract Person', role: 'Fitter' });
  ok(employee, 'employee create');
  ok(await api(ctx, 'PATCH', `/api/employees/${employee.body.employee.id}`, { phone: '9000000004' }), 'employee update');
  ok(await api(ctx, 'DELETE', `/api/departments/${deptId}`), 'department delete, with its people');
  const stillThere = (await api(ctx, 'GET', '/api/employees')).body.employees;
  assert.ok(!stillThere.some((row) => row.id === employee.body.employee.id), 'the employee went with the department');

  // Machines and dies
  const machine = await api(ctx, 'POST', '/api/machines', { name: 'Contract Press', assetId: 'CP-1', location: 'Shop 1', status: 'active' });
  ok(machine, 'machine create');
  ok(await api(ctx, 'POST', '/api/machines', { id: machine.body.machine.id, location: 'Shop 2' }), 'machine update');
  ok(await api(ctx, 'GET', `/api/machines/${machine.body.machine.id}`), 'machine get');
  ok(await api(ctx, 'DELETE', `/api/machines/${machine.body.machine.id}`), 'machine delete');
  const die = await api(ctx, 'POST', '/api/dies', { toolCode: 'CD-1', status: 'active', ownership: 'inHouse' });
  ok(die, 'die create');
  ok(await api(ctx, 'GET', `/api/dies/${die.body.die.id}`), 'die get');
  ok(await api(ctx, 'DELETE', `/api/dies/${die.body.die.id}`), 'die delete');

  // Pipeline templates
  const template = { id: 'tpl-contract-1', name: 'Contract route', version: 1, factoryId: '', nodes: [], edges: [] };
  ok(await api(ctx, 'POST', '/api/production/pipeline-templates', template), 'template save');
  ok(await api(ctx, 'PUT', '/api/production/pipeline-templates/tpl-contract-1', { name: 'Contract route 2' }), 'template update');
  ok(await api(ctx, 'DELETE', '/api/production/pipeline-templates/tpl-contract-1'), 'template delete');

  const masters = /^(vendors|clients|people|machines|dies|pipelines)\./;
  const broken = Object.entries(ctx.desk.violationCounts()).filter(([name]) => masters.test(name));
  assert.deepEqual(broken, [], 'contracts broken by ordinary use');
});

test('routes that were never behind a module permission ask exactly what they always asked', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const staff = { actor: { kind: 'user', user: { id: 50, role: 'user' }, permissions: {} } };
  const stockClerk = { actor: { kind: 'user', user: { id: 51, role: 'user' }, permissions: { 'inventory.update': true } } };
  const configurer = { actor: { kind: 'user', user: { id: 52, role: 'user' }, permissions: { 'config.write': true } } };
  const admin = { actor: { kind: 'user', user: { id: 53, role: 'admin' }, permissions: {} } };
  const code = async (name, input, who) => (await ctx.desk.call(name, input, who)).code;

  // The older /templates set: anyone signed in reads, config.write changes.
  assert.equal((await ctx.desk.call('pipelines.legacyTemplates.list', {}, staff)).ok, true);
  assert.equal(await code('pipelines.legacyTemplates.create', { data: { id: 't-x', name: 'X' } }, staff), 'forbidden');
  assert.equal(await code('pipelines.legacyTemplates.create', { data: { id: 't-x', name: 'X' } }, stockClerk), 'forbidden');
  const made = await ctx.desk.call('pipelines.legacyTemplates.create', { data: { id: 't-x', name: 'X' } }, configurer);
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((await ctx.desk.call('pipelines.legacyTemplates.delete', { id: 't-x' }, configurer)).ok, true);
  assert.deepEqual(await ctx.desk.call('pipelines.legacyTemplates.get', { id: 't-x' }, staff), {
    ok: false, status: 404, template: null, error: 'Template not found.',
  });

  // The portal: reading needs a session; a POST needs what the old write gate
  // asked — an admin, or config.write, or inventory.update.
  assert.equal((await ctx.desk.call('clients.portal.catalog', { clientId: 1 }, staff)).ok, true);
  assert.equal(await code('clients.portal.addToCart', { portal_user_id: 1, item_id: 1, quantity: 1 }, staff), 'forbidden');
  for (const who of [stockClerk, configurer, admin]) {
    const refused = await ctx.desk.call('clients.portal.login', { email: 'nobody@example.test', password: 'x' }, who);
    assert.equal(refused.status, 401, 'let through to the credential check');
    assert.equal(refused.error, 'Invalid credentials');
  }

  // An employee's login: an admin or a super admin, whatever else is held.
  assert.equal(await code('people.employees.unlinkLogin', { id: 1 }, configurer), 'forbidden');
  assert.equal(await code('people.employees.createLogin', { id: 1 }, { actor: { ...configurer.actor, permissions: { 'users.create_user': true } } }), 'forbidden');
  assert.equal(await code('people.employees.createLogin', { id: 999999 }, admin), 'forbidden', 'an admin still needs users.create_user');
  const asAdmin = await ctx.desk.call('people.employees.unlinkLogin', { id: 999999 }, admin);
  assert.deepEqual(asAdmin, { ok: false, status: 404, error: 'Employee not found.' });

  // Over HTTP the same answers come back, for the owner.
  assert.equal((await api(ctx, 'GET', '/templates')).status, 200);
  assert.equal((await api(ctx, 'POST', '/api/portal/login', { email: 'nobody@example.test', password: 'x' })).status, 401);
  assert.equal((await api(ctx, 'POST', '/api/employees/999999/unlink-login', {})).status, 404);
});

test('contacts and die makers behind the desk: same answers, and no contract broken', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  // A company's people.
  const client = (await api(ctx, 'POST', '/api/clients', { name: 'People Client' })).body.client;
  const first = await api(ctx, 'POST', `/api/clients/${client.id}/contacts`, { name: 'Asha', phone: '9000000010' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.contact.isPrimary, true, 'the first person is the first call');
  const second = await api(ctx, 'POST', `/api/clients/${client.id}/contacts`, { name: 'Bala' });
  assert.equal(second.status, 201);
  assert.equal((await api(ctx, 'PATCH', `/api/clients/${client.id}/contacts/${second.body.contact.id}`, { isPrimary: true })).status, 200);
  assert.equal((await api(ctx, 'PATCH', `/api/clients/${client.id}/contacts/${first.body.contact.id}/archive`)).status, 200);

  const viaDesk = await ctx.desk.call('clients.contacts.list', { clientId: client.id }, system);
  const viaHttp = await api(ctx, 'GET', `/api/clients/${client.id}/contacts`);
  assert.deepEqual(viaHttp.body.contacts, plain(viaDesk.contacts));
  assert.deepEqual(await ctx.desk.call('clients.contacts.list', { clientId: 999999 }, system), {
    ok: false, status: 404, error: 'No such client.',
  });
  const nameless = await api(ctx, 'POST', `/api/clients/${client.id}/contacts`, { phone: '1' });
  assert.equal(nameless.status, 400);
  assert.deepEqual(nameless.body, { success: false, error: 'A person needs a name.' });

  // Die makers.
  const maker = await api(ctx, 'POST', '/api/die-makers', { name: 'Desk Toolroom' });
  assert.equal(maker.status, 200, JSON.stringify(maker.body));
  const twin = await api(ctx, 'POST', '/api/die-makers', { name: 'desk toolroom' });
  assert.equal(twin.status, 409);
  assert.deepEqual(twin.body, {
    success: false,
    error: '"Desk Toolroom" is already a die maker.',
    code: 'die_maker_duplicate',
    dieMakerId: maker.body.dieMaker.id,
  });
  assert.equal((await api(ctx, 'PATCH', `/api/die-makers/${maker.body.dieMaker.id}`, { phone: '9000000011' })).status, 200);
  const makersDesk = await ctx.desk.call('dies.makers.list', {}, system);
  const makersHttp = await api(ctx, 'GET', '/api/die-makers');
  assert.deepEqual(makersHttp.body.dieMakers, plain(makersDesk.dieMakers));
  const gone = await api(ctx, 'DELETE', `/api/die-makers/${maker.body.dieMaker.id}`);
  assert.deepEqual(gone.body, { success: true, archived: false });

  // None of this, refusals included, breaks a contract.
  const broken = Object.entries(ctx.desk.violationCounts())
    .filter(([name]) => /^(clients\.contacts|dies\.makers)\./.test(name));
  assert.deepEqual(broken, []);
});
