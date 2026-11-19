const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const ASKS = require('../modules/items/asks');
const { itemsClient } = require('../modules/items/client');
const { makeTempDir } = require('./helpers/temp-dir');

// Items behind the kernel desk.
//
// items-module, the item-sheet, group and master-data tests and the journey
// tests pin every HTTP answer, and passed unchanged. This file pins what is new,
// and the one place the change was more than moving code: an item's read used
// to be ONE statement joining seven tables of four other modules. It is now the
// item's own row plus what each owner answers at the desk. The first test runs
// the old statement beside the new read and requires the same answer.

// The statement GET /api/items/:id ran before, verbatim.
const OLD_ITEM_SQL = `
        SELECT
          items.*,
          pipeline_templates.name AS default_pipeline_name,
          developed_for_client.name AS developed_for_client_name,
          developed_for_client.contact_name AS developed_for_contact_name,
          developed_for_client.designation AS developed_for_designation,
          developed_for_client.phone AS developed_for_phone,
          developed_for_client.email AS developed_for_email,
          developed_for_contractor.name AS developed_for_sub_contractor_name,
          developed_for_contractor.designation AS developed_for_sub_contractor_designation,
          developed_for_contractor.phone AS developed_for_sub_contractor_phone,
          developed_for_contractor.email AS developed_for_sub_contractor_email,
          -- The people this part's deal was done with (056), as one JSON column so
          -- the list read stays one statement per page however many parts it has.
          (
            SELECT json_group_array(json_object(
              'id', c.id, 'name', c.name, 'designation', c.designation,
              'phone', c.phone, 'email', c.email, 'isArchived', c.is_archived
            ))
            FROM (
              SELECT pc.* FROM item_deal_contacts idc
              JOIN party_contacts pc ON pc.id = idc.contact_id
              WHERE idc.item_id = items.id
              ORDER BY pc.is_primary DESC, pc.name COLLATE NOCASE ASC
            ) c
          ) AS developed_for_contacts_json,
          (
            (SELECT COUNT(*) FROM order_items WHERE order_items.item_id = items.id) +
            (SELECT COUNT(*) FROM delivery_challan_items WHERE delivery_challan_items.item_id = items.id) +
            (SELECT COUNT(*) FROM order_material_requirements WHERE order_material_requirements.item_id = items.id) +
            (SELECT COUNT(*) FROM materials WHERE materials.linked_item_id = items.id) +
            (SELECT COUNT(*) FROM material_group_item_links WHERE material_group_item_links.item_id = items.id)
          ) AS usage_count
        FROM items
        LEFT JOIN pipeline_templates ON items.default_pipeline_id = pipeline_templates.id
        LEFT JOIN clients developed_for_client ON developed_for_client.id = items.developed_for_client_id
        LEFT JOIN sub_contractors developed_for_contractor ON developed_for_contractor.id = items.developed_for_sub_contractor_id
        WHERE items.id = ?
`;

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

async function boot() {
  const tempDir = makeTempDir('paper-items-ops-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'items@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'items@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'expected a login token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };
  const api = (method, route, body) =>
    fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  const group = await backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const unit = await backend.get('SELECT id, name FROM units WHERE is_archived = 0 ORDER BY id LIMIT 1');
  return { backend, desk: backend.desk, server, api, group, unit };
}

const system = { actor: { kind: 'system' } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const part = (ctx, name) => ({
  name, alias: '', displayName: name, groupId: ctx.group.id, unitId: ctx.unit.id, variationTree: [],
});

test('an item read is the same answer the one joined statement gave', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());
  const { backend, api } = ctx;

  // A part with everything the old statement joined: a default pipeline, a
  // client it was developed for, a sub-contractor, three people of the deal
  // (one archived), and use on an order.
  const item = await backend.saveItem(part(ctx, 'Joined part'));
  const client = (await api('POST', '/api/clients', {
    name: 'Developed For Ltd', contactName: 'Meera', designation: 'Buyer', phone: '9000000031', email: 'meera@example.test',
  })).body.client;
  const sub = (await api('POST', `/api/clients/${client.id}/sub-contractors`, {
    name: 'Polish Works', designation: 'Owner', phone: '9000000032', email: 'pw@example.test',
  })).body.subContractor;
  await api('POST', `/api/clients/${client.id}/contacts`, { name: 'Arun', phone: '9000000033' });
  const third = (await api('POST', `/api/clients/${client.id}/contacts`, { name: 'Zoya' })).body.contact;
  await api('PATCH', `/api/clients/${client.id}/contacts/${third.id}/archive`);
  const people = (await api('GET', `/api/clients/${client.id}/contacts`)).body.contacts;
  assert.ok(people.length >= 2, 'the client has several people');
  const template = await backend.get('SELECT id, name FROM pipeline_templates ORDER BY id LIMIT 1');
  await backend.run(
    'UPDATE items SET default_pipeline_id = ?, developed_for_client_id = ?, developed_for_sub_contractor_id = ? WHERE id = ?',
    [template.id, client.id, sub.id, item.id],
  );
  for (const person of people) {
    await backend.run('INSERT INTO item_deal_contacts (item_id, contact_id) VALUES (?, ?)', [item.id, person.id]);
  }
  const order = await api('POST', '/api/orders', {
    orderNo: 'JOIN-1', clientId: client.id, itemId: item.id, variationLeafNodeId: 0,
    variationPathNodeIds: [], quantity: 4, status: 'notStarted',
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));

  // The old statement really does find all of it, so the comparison means something.
  const oldRow = await backend.get(OLD_ITEM_SQL, [item.id]);
  assert.equal(oldRow.default_pipeline_name, template.name);
  assert.equal(oldRow.developed_for_client_name, 'Developed For Ltd');
  assert.equal(oldRow.developed_for_sub_contractor_name, 'Polish Works');
  assert.equal(JSON.parse(oldRow.developed_for_contacts_json).length, people.length);
  assert.ok(oldRow.usage_count >= 1);

  const expected = plain(await backend.rowToItemDto(oldRow));
  const viaHttp = await api('GET', `/api/items/${item.id}`);
  assert.equal(viaHttp.status, 200);
  assert.deepEqual(viaHttp.body.item, expected);
  const viaDesk = await ctx.desk.call('items.get', { id: item.id }, system);
  assert.deepEqual(plain(viaDesk.item), expected);

  // And a bare item, where every join found nothing.
  const bare = await backend.saveItem(part(ctx, 'Bare part'));
  const bareOld = plain(await backend.rowToItemDto(await backend.get(OLD_ITEM_SQL, [bare.id])));
  assert.deepEqual((await api('GET', `/api/items/${bare.id}`)).body.item, bareOld);

  // An item in use cannot be archived, as before.
  const blocked = await api('PATCH', `/api/items/${item.id}/archive`, { archived: true });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /cannot be archived/);
  const missing = await api('GET', '/api/items/999999');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { success: false, item: null, error: 'Not found' });
});

test('a group’s overview still names each item’s unit', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  await ctx.backend.saveItem(part(ctx, 'Unit named part'));
  const overview = await ctx.api('GET', `/api/groups/${ctx.group.id}/overview`);
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const text = JSON.stringify(overview.body);
  assert.ok(text.includes('Unit named part'), 'the item is on the overview');
  assert.ok(text.includes(`"unitName":${JSON.stringify(ctx.unit.name)}`), 'with its unit’s name');
});

test('items, groups and the smaller masters are the same through the desk and over HTTP', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  for (const [operation, route] of [
    ['items.list', '/api/items'],
    ['items.groups.list', '/api/groups'],
    ['items.materialTypes.list', '/api/material-types'],
    ['items.sheetProperties.list', '/api/item-sheet-properties'],
  ]) {
    const viaDesk = await ctx.desk.call(operation, { query: {} }, system);
    const viaHttp = await ctx.api('GET', route);
    assert.equal(viaDesk.ok, true, operation);
    assert.equal(viaHttp.status, 200, route);
    const { ok, ...rest } = viaDesk;
    assert.deepEqual(viaHttp.body, { success: true, ...plain(rest) }, operation);
  }

  // A write still leaves its Track entry to the route, and the answer the app
  // gets carries no `track`.
  const made = await ctx.api('POST', '/api/groups', { name: 'Desk Group', unitId: ctx.unit.id });
  assert.ok(made.status < 300, JSON.stringify(made.body));
  assert.equal('track' in made.body, false);
  const viaDesk = await ctx.desk.call('items.groups.create', { data: { name: 'Desk Group 2', unitId: ctx.unit.id } }, system);
  assert.equal(viaDesk.ok, true, JSON.stringify(viaDesk));
  assert.equal(viaDesk.track[0][0], 'create');
  assert.equal(viaDesk.track[0][1], 'groups');
});

test('who may ask: items keys by method, attachment keys for photos, the old gate for material types', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  assert.equal(listed['items.get'].permission, 'items.read');
  assert.equal(listed['items.create'].permission, 'items.create');
  assert.equal(listed['items.archive'].permission, 'items.update');
  assert.equal(listed['items.delete'].permission, 'items.delete');
  assert.equal(listed['items.photos.list'].permission, 'items.asset.list');
  assert.equal(listed['items.photos.arrange'].permission, 'items.asset.upload');
  assert.equal(listed['items.materialTypes.list'].access, 'signedIn');
  assert.deepEqual(listed['items.materialTypes.create'].access, {
    anyRole: ['super_admin', 'admin'],
    anyPermission: ['config.write', 'inventory.update'],
  });
  assert.equal(listed['items.masterData.forPipeline'].access, 'signedIn');
  assert.equal(listed['items.masterData.save'].permission, 'items.update');

  const as = (permissions) => ({ actor: { kind: 'user', user: { id: 90, role: 'user', name: 'Tester' }, permissions } });
  assert.equal((await ctx.desk.call('items.list', { query: {} }, as({}))).code, 'forbidden');
  assert.equal((await ctx.desk.call('items.list', { query: {} }, as({ 'items.read': true }))).ok, true);
  assert.equal((await ctx.desk.call('items.materialTypes.list', { query: {} }, as({}))).ok, true);
  assert.equal((await ctx.desk.call('items.materialTypes.create', { data: {} }, as({ 'items.create': true }))).code, 'forbidden');
});

test('neighbours hold an items client, and items asks them, for what each declared', async (t) => {
  const ctx = await boot();
  t.after(() => ctx.server.close());

  const item = await ctx.backend.saveItem(part(ctx, 'Asked part'));
  const names = ASKS.map((ask) => ask.as || ask.port);
  assert.equal(new Set(names).size, names.length, 'no two asks share an operation name');

  const forProduction = itemsClient(ctx.desk.as('production'));
  assert.equal((await forProduction.lookupByName('asked PART')).id, item.id);
  assert.ok(await forProduction.selectionSnapshot(item.id, 0), 'a simple item has a snapshot under leaf 0');
  await assert.rejects(forProduction.groups.save({ name: 'Not allowed' }), (error) => error.code === 'not_declared');
  await assert.rejects(
    itemsClient(ctx.desk.as('clients')).describe(item.id),
    (error) => error.code === 'not_declared',
  );
  assert.equal(await itemsClient(ctx.desk.as('inventory')).stock.holdsWholeItemStock(item.id), true);
  assert.equal(await itemsClient(ctx.desk.as('parties')).developedForCount(999999), 0);

  // A refusal the items code throws reaches the caller as the error it was.
  await assert.rejects(
    itemsClient(ctx.desk.as('orders')).resolveSelection({ itemId: 999999, variationLeafNodeId: 0 }),
    (error) => error.code !== 'not_declared' && error.message.length > 0,
  );

  const forItems = ctx.desk.as('items');
  assert.equal((await forItems.ask('orders.items.usage', { itemId: item.id })).count, 0);
  assert.equal((await forItems.ask('challans.items.lineCount', { itemId: item.id })).count, 0);
  assert.equal((await forItems.ask('inventory.items.usage', { itemId: item.id })).count, 0);
  assert.equal((await forItems.ask('inventory.sets.name', { id: 999999 })).name, null);
  assert.equal((await forItems.call('people.employees.list', {})).code, 'not_declared');

  const listed = Object.fromEntries(ctx.desk.catalogue().map((o) => [o.name, o]));
  assert.equal(listed['items.stock.applyDelta'].joinsCallerTransaction, true);
  assert.deepEqual(listed['items.stock.applyDelta'].usedBy, ['challans', 'inventory', 'production']);

  const broken = Object.entries(ctx.desk.violationCounts()).filter(([name]) => name.startsWith('items.'));
  assert.deepEqual(broken, []);
});
