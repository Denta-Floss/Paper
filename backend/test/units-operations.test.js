const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Units as a module that keeps to its own tables.
//
// How much a unit is used decides whether it may still be renamed or archived.
// It was one subquery over four other modules' tables; it is now the sum of
// what inventory, items and orders each answer at the kernel desk, plus the
// units that convert through it. The first test pins that the number, and what
// it guards, did not change. The rest pin three things that were wrong before
// and were found while moving the code (see Docs/architecture/12, bugs).

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

async function boot({ seed = true } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-units-ops-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'units-ops@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  if (seed) await backend.resetAndSeedDemoData();
  else await backend.initDb();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = async (email, password) => {
    const body = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json());
    assert.ok(body.token, `expected a login token for ${email}`);
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${body.token}` };
  };
  return { backend, desk: backend.desk, server, baseUrl, login, headers: await login('units-ops@example.test', 'OwnerPass1234') };
}

function api(ctx, method, route, body, headers = ctx.headers) {
  return fetch(`${ctx.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const system = { actor: { kind: 'system' } };

test('a unit’s usage is the sum of what its neighbours answer, and still guards it', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const made = await api(ctx, 'POST', '/api/units', { name: 'Bundle', symbol: 'bdl' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const unitId = made.body.unit.id;
  assert.equal(made.body.unit.usageCount, 0);

  // Unused: it may be renamed.
  const renamed = await api(ctx, 'PATCH', `/api/units/${unitId}`, { name: 'Bundle of ten', symbol: 'bdl' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  // Used by an item (items' table) and an order line (orders' table).
  const group = await ctx.backend.get('SELECT id FROM groups WHERE is_archived = 0 ORDER BY id LIMIT 1');
  const item = await ctx.backend.saveItem({
    name: 'Bundled part', alias: '', displayName: 'Bundled part', groupId: group.id, unitId, variationTree: [],
  });
  const client = (await api(ctx, 'POST', '/api/clients', { name: 'Unit usage client' })).body.client;
  const order = await api(ctx, 'POST', '/api/orders', {
    orderNo: 'UNIT-1', clientId: client.id, itemId: item.id, variationLeafNodeId: 0,
    variationPathNodeIds: [], quantity: 5, status: 'notStarted', unitId,
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));

  // Each neighbour's own answer…
  const fromItems = (await ctx.desk.as('units').ask('items.units.usageCounts', { unitId })).counts[unitId] || 0;
  const fromOrders = (await ctx.desk.as('units').ask('orders.units.usageCounts', { unitId })).counts[unitId] || 0;
  const fromInventory = (await ctx.desk.as('units').ask('inventory.units.usageCounts', { unitId })).counts[unitId] || 0;
  assert.ok(fromItems >= 1, 'the item counts');
  assert.ok(fromOrders >= 1, 'the order line counts');

  // …adds up to what the old single query counted, table by table.
  const old = await ctx.backend.get(
    `SELECT
       (SELECT COUNT(*) FROM materials WHERE unit_id = ?) +
       (SELECT COUNT(*) FROM groups WHERE unit_id = ?) +
       (SELECT COUNT(*) FROM items WHERE unit_id = ?) +
       (SELECT COUNT(*) FROM item_unit_conversions WHERE unit_id = ?) +
       (SELECT COUNT(*) FROM order_items WHERE unit_id = ?) +
       (SELECT COUNT(*) FROM units WHERE conversion_base_unit_id = ?) +
       (SELECT COUNT(*) FROM order_material_requirements WHERE unit_id = ?) AS count`,
    [unitId, unitId, unitId, unitId, unitId, unitId, unitId],
  );
  const listed = (await api(ctx, 'GET', '/api/units')).body.units.find((unit) => unit.id === unitId);
  assert.equal(listed.usageCount, old.count);
  assert.equal(listed.usageCount, fromItems + fromOrders + fromInventory);

  // And every unit in the list agrees with the old count, not just this one.
  for (const unit of (await api(ctx, 'GET', '/api/units')).body.units) {
    const was = await ctx.backend.get(
      `SELECT
         (SELECT COUNT(*) FROM materials WHERE unit_id = ?) +
         (SELECT COUNT(*) FROM groups WHERE unit_id = ?) +
         (SELECT COUNT(*) FROM items WHERE unit_id = ?) +
         (SELECT COUNT(*) FROM item_unit_conversions WHERE unit_id = ?) +
         (SELECT COUNT(*) FROM order_items WHERE unit_id = ?) +
         (SELECT COUNT(*) FROM units WHERE conversion_base_unit_id = ?) +
         (SELECT COUNT(*) FROM order_material_requirements WHERE unit_id = ?) AS count`,
      Array(7).fill(unit.id),
    );
    assert.equal(unit.usageCount, was.count, `usage of ${unit.name}`);
  }

  // In use: its identity is locked and it cannot be archived.
  const locked = await api(ctx, 'PATCH', `/api/units/${unitId}`, { name: 'Renamed', symbol: 'bdl' });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /cannot change identity/);
  const archive = await api(ctx, 'PATCH', `/api/units/${unitId}/archive`);
  assert.equal(archive.status, 409);
  assert.equal(archive.body.error, 'Unit is in use');

  // The same refusal as a result, with no request.
  assert.deepEqual(await ctx.desk.call('units.archive', { id: unitId }, system), {
    ok: false, status: 409, error: 'Unit is in use',
  });
  assert.deepEqual(await ctx.desk.call('units.archive', { id: 999999 }, system), {
    ok: false, status: 404, error: 'Not found',
  });
});

test('units keep to what they have declared, and inventory and challans ask them at the desk', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const kg = await ctx.desk.as('challans').ask('units.ensureKilogram');
  assert.ok(kg.unitId > 0);
  assert.equal((await ctx.desk.as('challans').ask('units.ensureKilogram')).unitId, kg.unitId, 'made once');

  const row = (await ctx.desk.as('inventory').ask('units.rows.get', { id: kg.unitId })).row;
  assert.equal(row.id, kg.unitId);
  assert.equal(typeof row.usage_count, 'number');

  assert.equal((await ctx.desk.as('units').call('orders.delete', { id: 1 })).code, 'not_declared');
  assert.equal((await ctx.desk.as('orders').call('units.rows.get', { id: kg.unitId })).code, 'not_declared');
});

test('the converter works on a server that has only just started', async (t) => {
  // It used to answer "Unit not found" for every line until a unit had been
  // saved since the last restart: the conversion graph was built on save only.
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const units = (await api(ctx, 'GET', '/api/units')).body.units;
  const derived = units.find((unit) => unit.conversionBaseUnitId && unit.conversionType === 'linear' && !unit.isArchived);
  assert.ok(derived, 'the seed has a unit that converts to a base');

  const converted = await api(ctx, 'POST', '/api/units/convert-batch', {
    conversions: [
      { value: 2, fromUnitId: derived.id, toUnitId: derived.conversionBaseUnitId },
      { value: 1, fromUnitId: 999999, toUnitId: derived.id },
    ],
  });
  assert.equal(converted.status, 200);
  assert.deepEqual(converted.body.results[0], { success: true, value: 2 * derived.conversionFactor });
  // A bad line answers for itself and does not fail the batch.
  assert.equal(converted.body.results[1].success, false);
});

test('seeding the standard units answers success', async (t) => {
  // It used to seed and then answer 500: the handler called .catch() on the
  // nothing that the fire-and-forget Track helper returns.
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const seeded = await api(ctx, 'POST', '/api/units/seed-standard');
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  assert.equal(seeded.body.success, true);

  const families = await api(ctx, 'GET', '/api/units/families');
  assert.equal(families.status, 200);
  assert.ok(families.body.families.some((family) => family.code === 'mass' && family.units.length > 0));
});

test('unit families are behind the units permissions, and converting needs only read', async (t) => {
  // /api/unit-groups mapped to no module, so any signed-in user could read it
  // and the old write gate let anyone with inventory.update change it.
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  // Staff read every module and write none by default, so both halves of each
  // grid are said outright.
  const make = async (email, overrides) => {
    const created = await api(ctx, 'POST', '/api/users', {
      name: email, email, password: 'ClerkPass1234', role: 'user', permissions: ['login.desktop'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const grid = await api(ctx, 'PATCH', `/api/users/${created.body.user.id}/permissions`, { overrides });
    assert.equal(grid.status, 200, JSON.stringify(grid.body));
    return ctx.login(email, 'ClerkPass1234');
  };
  // May change stock (which the old write gate accepted for unit families) and
  // may not so much as see a unit.
  const stockClerk = await make('stock@example.test', [
    { key: 'inventory.update', allowed: true },
    { key: 'units.read', allowed: false },
  ]);
  const reader = await make('reader@example.test', [{ key: 'units.read', allowed: true }]);

  assert.equal((await api(ctx, 'GET', '/api/unit-groups', undefined, stockClerk)).status, 403);
  assert.equal((await api(ctx, 'POST', '/api/unit-groups', { name: 'Sneaked in' }, stockClerk)).status, 403);

  assert.equal((await api(ctx, 'GET', '/api/unit-groups', undefined, reader)).status, 200);
  assert.equal((await api(ctx, 'POST', '/api/unit-groups', { name: 'Not allowed' }, reader)).status, 403);
  assert.equal((await api(ctx, 'POST', '/api/units', { name: 'Nope', symbol: 'np' }, reader)).status, 403);

  // Converting is a read that happens to be a POST.
  const converted = await api(ctx, 'POST', '/api/units/convert-batch', { conversions: [] }, reader);
  assert.equal(converted.status, 200, JSON.stringify(converted.body));

  // The owner still does everything.
  const made = await api(ctx, 'POST', '/api/unit-groups', { name: 'Packs' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api(ctx, 'PATCH', `/api/unit-groups/${made.body.unitGroup.id}`, { name: 'Packs', dimension: 'count' })).status, 200);
  assert.equal((await api(ctx, 'DELETE', `/api/unit-groups/${made.body.unitGroup.id}`)).status, 200);
});

test('ordinary use breaks none of the units contracts', async (t) => {
  // The contracts are enforced. Ordinary use must never trip one.
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const made = await api(ctx, 'POST', '/api/units', {
    name: 'Hamper', symbol: 'hmp', notes: '', unitGroupName: '', conversionFactor: 1,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await api(ctx, 'PATCH', `/api/units/${made.body.unit.id}`, { name: 'Hamper', symbol: 'hmp', notes: 'A basket' });
  await api(ctx, 'GET', '/api/units');
  await api(ctx, 'GET', '/api/unit-groups');
  await api(ctx, 'GET', '/api/units/families');
  await api(ctx, 'GET', '/api/units/gauge-table');
  await api(ctx, 'POST', '/api/units/convert-batch', { conversions: [{ value: 1, fromUnitId: made.body.unit.id, toUnitId: made.body.unit.id }] });
  await api(ctx, 'PATCH', `/api/units/${made.body.unit.id}/archive`);
  await api(ctx, 'DELETE', `/api/units/${made.body.unit.id}`);

  const broken = Object.keys(ctx.desk.violationCounts()).filter((name) => name.includes('units'));
  assert.deepEqual(broken, [], JSON.stringify(ctx.desk.violationCounts()));

  // A call that does break one is refused, in words about the field, and is
  // on record where an operator can read it. It used to reach the master and
  // come back as a server error.
  const refused = await api(ctx, 'POST', '/api/units', { name: 12, symbol: '' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { success: false, unit: null, error: 'name must be a string' });
  assert.deepEqual(ctx.desk.violationCounts()['units.create'], { input: 1, output: 0 });
  const alerts = (await api(ctx, 'GET', '/api/kernel/guard-alerts')).body.alerts;
  assert.ok(alerts.some((alert) => alert.route === 'operation units.create (input, enforce)'));

  const nameless = await api(ctx, 'POST', '/api/units', { symbol: 'x' });
  assert.equal(nameless.status, 400);
  assert.equal(nameless.body.error, 'name is required');
  const noFamilyName = await api(ctx, 'POST', '/api/unit-groups', {});
  assert.equal(noFamilyName.status, 400);
  assert.equal(noFamilyName.body.error, 'name is required');

  // What the master decides stays the master's to say: a unit with no family
  // may carry any factor, and the old wording for a grouped one is unchanged.
  const loose = await api(ctx, 'POST', '/api/units', { name: 'Zero Factor', symbol: 'zf', conversionFactor: 0 });
  assert.equal(loose.status, 201, JSON.stringify(loose.body));
});

test('a master’s own refusals keep their own words under enforced contracts', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  const client = await api(ctx, 'POST', '/api/clients', { name: '   ' });
  assert.equal(client.status, 400);
  assert.notEqual(client.body.error, 'name must not be empty', 'the client master says it its own way');
  const vendor = await api(ctx, 'POST', '/api/vendors', {});
  assert.equal(vendor.status, 400);
  assert.equal(vendor.body.error, 'Vendor name is required.');
  const maker = await api(ctx, 'POST', '/api/die-makers', {});
  assert.equal(maker.status, 400);
  assert.equal(maker.body.error, 'A die maker needs a name.');

  // Enforcement is the server's default, and every operation is under it.
  const modes = new Set(ctx.desk.catalogue().map((operation) => operation.mode));
  assert.deepEqual([...modes], ['enforce']);
});
