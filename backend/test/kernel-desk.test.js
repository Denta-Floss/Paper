const assert = require('node:assert/strict');
const test = require('node:test');

const { createDesk } = require('../kernel/desk');

// The desk is the one border every call to a module crosses, whichever door it
// came through. These are pure: no server, no database.

function deskWithOrders() {
  const desk = createDesk();
  const seen = [];
  desk.register('orders', {
    operations: {
      'orders.get': {
        permission: 'orders.read',
        summary: 'One order.',
        mode: 'enforce',
        input: { fields: { id: { type: 'integer', required: true, gt: 0 } } },
        output: { fields: { order: { type: 'object', required: true } } },
        run: async (input) => {
          seen.push(input);
          return { ok: true, order: { id: Number(input.id) } };
        },
      },
      'orders.lines.count': {
        internal: true,
        run: async () => ({ ok: true, count: 3 }),
      },
      'orders.refuses': {
        permission: 'orders.update',
        run: async () => ({ ok: false, status: 409, code: 'order_locked', error: 'Locked.' }),
      },
    },
  });
  return { desk, seen };
}

const system = { kind: 'system' };
const reader = { kind: 'user', user: { role: 'user' }, permissions: { 'orders.read': true } };
const stranger = { kind: 'user', user: { role: 'user' }, permissions: {} };
const superAdmin = { kind: 'user', user: { role: 'super_admin' }, permissions: {} };

test('an operation runs and returns its result', async () => {
  const { desk, seen } = deskWithOrders();
  const result = await desk.call('orders.get', { id: 7 }, { actor: system });
  assert.deepEqual(result, { ok: true, order: { id: 7 } });
  assert.deepEqual(seen, [{ id: 7 }]);
});

test('a refusal from the operation is passed through untouched', async () => {
  const { desk } = deskWithOrders();
  const result = await desk.call('orders.refuses', {}, { actor: system });
  assert.deepEqual(result, { ok: false, status: 409, code: 'order_locked', error: 'Locked.' });
});

test('an unknown operation is a 404, not a throw', async () => {
  const { desk } = deskWithOrders();
  const result = await desk.call('orders.nope', {}, { actor: system });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, 'operation_unknown');
});

test('input that breaks the contract is refused before the function runs', async () => {
  const { desk, seen } = deskWithOrders();
  const missing = await desk.call('orders.get', {}, { actor: system });
  assert.equal(missing.status, 400);
  assert.equal(missing.code, 'input_invalid');
  assert.equal(missing.problems[0].code, 'missing');

  const negative = await desk.call('orders.get', { id: -1 }, { actor: system });
  assert.equal(negative.code, 'input_invalid');
  assert.equal(seen.length, 0);
});

test('a call that does not say who is asking is refused', async () => {
  const { desk } = deskWithOrders();
  assert.equal((await desk.call('orders.get', { id: 1 })).code, 'actor_unknown');
  assert.equal(
    (await desk.call('orders.get', { id: 1 }, { actor: { kind: 'robot' } })).code,
    'actor_unknown',
  );
});

test('a user needs the operation’s permission', async () => {
  const { desk } = deskWithOrders();
  assert.equal((await desk.call('orders.get', { id: 1 }, { actor: reader })).ok, true);

  const denied = await desk.call('orders.get', { id: 1 }, { actor: stranger });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'forbidden');
  assert.equal(denied.permission, 'orders.read');

  assert.equal((await desk.call('orders.get', { id: 1 }, { actor: superAdmin })).ok, true);
});

test('in report mode a broken input contract is recorded and the call carries on', async () => {
  const seen = [];
  const desk = createDesk({ onViolation: (violation) => seen.push(violation) });
  desk.register('orders', {
    operations: {
      'orders.get': {
        permission: 'orders.read',
        input: { fields: { id: { type: 'integer', required: true } } },
        run: async (input) => ({ ok: true, got: input.id }),
      },
    },
  });
  const result = await desk.call('orders.get', { id: 'abc' }, { actor: system });
  assert.deepEqual(result, { ok: true, got: 'abc' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].operation, 'orders.get');
  assert.equal(seen[0].side, 'input');
  assert.equal(seen[0].mode, 'report');
  assert.equal(seen[0].problems[0].code, 'not-a-number');
  assert.deepEqual(desk.violationCounts(), { 'orders.get': { input: 1, output: 0 } });
});

test('an output contract is checked on ok results only', async () => {
  const seen = [];
  const desk = createDesk({ onViolation: (violation) => seen.push(violation) });
  const output = { fields: { count: { type: 'integer', required: true } } };
  desk.register('orders', {
    operations: {
      'orders.reported': { internal: true, output, run: async () => ({ ok: true, count: 'many' }) },
      'orders.enforced': {
        internal: true,
        mode: 'enforce',
        output,
        run: async (input) => (input.refuse
          ? { ok: false, status: 409, code: 'no', error: 'No.' }
          : { ok: true }),
      },
      'orders.right': { internal: true, mode: 'enforce', output, run: async () => ({ ok: true, count: 2 }) },
    },
  });

  // Reported: the wrong result still reaches the caller, and is on record.
  assert.deepEqual(await desk.call('orders.reported', {}, { actor: system }), { ok: true, count: 'many' });
  assert.equal(seen[0].side, 'output');

  // Enforced: a module that breaks its own promise has a bug, and it throws.
  await assert.rejects(desk.call('orders.enforced', {}, { actor: system }), /broke its output contract/);

  // A refusal is not held to the ok shape.
  assert.equal((await desk.call('orders.enforced', { refuse: true }, { actor: system })).code, 'no');
  assert.equal((await desk.call('orders.right', {}, { actor: system })).count, 2);
});

test('the user rule can be replaced by the server’s own', async () => {
  const { desk } = deskWithOrders();
  const asked = [];
  desk.setUserCheck((actor, key) => {
    asked.push(key);
    return false;
  });
  const denied = await desk.call('orders.get', { id: 1 }, { actor: superAdmin });
  assert.equal(denied.code, 'forbidden');
  assert.deepEqual(asked, ['orders.read']);
});

test('access rules other than a permission: any signed-in user, a role, a role or a key', async () => {
  const desk = createDesk();
  const run = async () => ({ ok: true });
  desk.register('portal', {
    operations: {
      'portal.read': { access: 'signedIn', run },
      'portal.write': { access: { anyRole: ['admin'], anyPermission: ['config.write'] }, run },
      'portal.adminOnly': { roles: ['super_admin', 'admin'], access: 'signedIn', run },
      'portal.adminWithKey': { roles: ['super_admin', 'admin'], permission: 'users.create_user', run },
    },
  });
  const as = (role, permissions = {}) => ({ actor: { kind: 'user', user: { id: 1, role }, permissions } });
  const code = async (name, who) => (await desk.call(name, {}, who)).code;

  // Any signed-in user; somebody with no user at all is not one.
  assert.equal((await desk.call('portal.read', {}, as('user'))).ok, true);
  assert.equal(await code('portal.read', { actor: { kind: 'user', user: null, permissions: {} } }), 'not_signed_in');

  // A role in the list, or any one of the keys.
  assert.equal((await desk.call('portal.write', {}, as('admin'))).ok, true);
  assert.equal((await desk.call('portal.write', {}, as('user', { 'config.write': true }))).ok, true);
  assert.equal(await code('portal.write', as('user')), 'forbidden');

  // A role required on top of whatever else is asked.
  assert.equal((await desk.call('portal.adminOnly', {}, as('admin'))).ok, true);
  assert.equal(await code('portal.adminOnly', as('user')), 'forbidden');
  assert.equal(await code('portal.adminWithKey', as('admin')), 'forbidden');
  assert.equal((await desk.call('portal.adminWithKey', {}, as('admin', { 'users.create_user': true }))).ok, true);
  assert.equal(await code('portal.adminWithKey', as('user', { 'users.create_user': true })), 'forbidden');

  // The catalogue says which rule each is under.
  const listed = Object.fromEntries(desk.catalogue().map((o) => [o.name, o]));
  assert.equal(listed['portal.read'].access, 'signedIn');
  assert.deepEqual(listed['portal.adminWithKey'].roles, ['super_admin', 'admin']);

  // A rule that lets nobody in is a mistake, caught when it is registered.
  assert.throws(
    () => desk.register('x', { operations: { 'x.y': { access: {}, run } } }),
    /lets nobody in/,
  );
});

test('an internal operation is not offered to users, even a super admin', async () => {
  const { desk } = deskWithOrders();
  const denied = await desk.call('orders.lines.count', {}, { actor: superAdmin });
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'operation_internal');
  assert.equal((await desk.call('orders.lines.count', {}, { actor: system })).count, 3);
});

test('a module may only ask for what it has declared it uses', async () => {
  const { desk } = deskWithOrders();
  desk.register('clients', { uses: ['orders.lines.count'] });

  const clients = desk.as('clients');
  assert.equal((await clients.call('orders.lines.count')).count, 3);

  const undeclared = await clients.call('orders.get', { id: 1 });
  assert.equal(undeclared.status, 403);
  assert.equal(undeclared.code, 'not_declared');

  const nobody = await desk.as('vendors').call('orders.lines.count');
  assert.equal(nobody.code, 'not_declared');
});

test('a module asking itself needs no declaration', async () => {
  const { desk } = deskWithOrders();
  assert.equal((await desk.as('orders').call('orders.lines.count')).count, 3);
});

test('ask() turns a refusal into a thrown error carrying the result', async () => {
  const { desk } = deskWithOrders();
  desk.register('clients', { uses: ['orders.lines.count'] });
  const clients = desk.as('clients');

  assert.equal((await clients.ask('orders.lines.count')).count, 3);
  await assert.rejects(clients.ask('orders.get', { id: 1 }), (error) => {
    assert.equal(error.code, 'not_declared');
    assert.equal(error.statusCode, 403);
    assert.equal(error.result.ok, false);
    return true;
  });
});

test('a thrown error inside an operation is a bug and is not swallowed', async () => {
  const desk = createDesk();
  desk.register('orders', {
    operations: {
      'orders.breaks': { internal: true, run: async () => { throw new Error('boom'); } },
      'orders.shapeless': { internal: true, run: async () => [1, 2, 3] },
    },
  });
  await assert.rejects(desk.call('orders.breaks', {}, { actor: system }), /boom/);
  await assert.rejects(desk.call('orders.shapeless', {}, { actor: system }), /did not return/);
});

test('registration refuses names outside the module, duplicates, and ungated operations', () => {
  const desk = createDesk();
  const run = async () => ({ ok: true });
  assert.throws(
    () => desk.register('orders', { operations: { 'inventory.get': { internal: true, run } } }),
    /must be named 'orders/,
  );
  assert.throws(
    () => desk.register('orders', { operations: { 'orders.get': { run } } }),
    /needs a permission, an access rule/,
  );
  assert.throws(
    () => desk.register('orders', { operations: { 'orders.get': { permission: 'orders.read' } } }),
    /no run function/,
  );
  desk.register('orders', { operations: { 'orders.get': { permission: 'orders.read', run } } });
  assert.throws(
    () => desk.register('orders', { operations: { 'orders.get': { permission: 'orders.read', run } } }),
    /already registered/,
  );
});

test('the catalogue, declared uses and call counts describe the desk', async () => {
  const { desk } = deskWithOrders();
  desk.register('clients', { uses: ['orders.lines.count'] });

  const listed = desk.catalogue();
  assert.deepEqual(listed.map((o) => o.name), ['orders.get', 'orders.lines.count', 'orders.refuses']);
  assert.deepEqual(listed[0], {
    name: 'orders.get',
    module: 'orders',
    permission: 'orders.read',
    internal: false,
    mode: 'enforce',
    joinsCallerTransaction: false,
    summary: 'One order.',
    input: { id: { type: 'integer', required: true, gt: 0 } },
    output: { order: { type: 'object', required: true } },
    usedBy: [],
  });
  assert.equal(listed[1].internal, true);
  assert.equal(listed[1].mode, 'report');
  assert.equal(listed[1].output, null);
  assert.deepEqual(listed[1].usedBy, ['clients']);

  assert.deepEqual(desk.declaredUses(), { clients: ['orders.lines.count'] });

  await desk.call('orders.get', { id: 1 }, { actor: system });
  await desk.call('orders.get', { id: 2 }, { actor: system });
  await desk.call('orders.get', {}, { actor: system }); // refused: not counted
  assert.equal(desk.stats().orders['orders.get'], 2);
  assert.equal(desk.stats().orders['orders.lines.count'], 0);
});

test('a desk can default to enforce, and an operator can force report over everything', async () => {
  const operations = () => ({
    'orders.get': {
      internal: true,
      input: { fields: { id: { type: 'integer', required: true } } },
      run: async () => ({ ok: true }),
    },
    'orders.lenient': {
      internal: true,
      mode: 'report',
      input: { fields: { id: { type: 'integer', required: true } } },
      run: async () => ({ ok: true }),
    },
  });

  const strict = createDesk({ defaultMode: 'enforce' });
  strict.register('orders', { operations: operations() });
  const refused = await strict.call('orders.get', {}, { actor: system });
  assert.equal(refused.code, 'input_invalid');
  // Said about the field; the full path stays in the problems.
  assert.equal(refused.error, 'id is required');
  assert.equal(refused.problems[0].path, 'orders.get.id');
  assert.equal((await strict.call('orders.lenient', {}, { actor: system })).ok, true, 'an operation can still ask for report');

  const forced = createDesk({ defaultMode: 'enforce', forceMode: 'report' });
  forced.register('orders', { operations: operations() });
  assert.equal((await forced.call('orders.get', {}, { actor: system })).ok, true);
  assert.deepEqual(forced.catalogue().map((o) => o.mode), ['report', 'report']);

  assert.throws(() => createDesk({ defaultMode: 'strict' }), /unknown contract mode/);
});

test('registration refuses an unknown strictness mode', () => {
  const desk = createDesk();
  assert.throws(
    () => desk.register('orders', {
      operations: { 'orders.get': { internal: true, mode: 'strict', run: async () => ({ ok: true }) } },
    }),
    /unknown mode/,
  );
});
