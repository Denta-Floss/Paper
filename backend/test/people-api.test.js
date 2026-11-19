const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The people master over HTTP: departments, employees, and the three routes
// that connect an employee to a login. activity-sittings.test.js touches the
// department and employee writes for their Track entries; this file pins the
// behaviour itself, and the login routes, which nothing else covers.
//
// Written before the people code left server.js.

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
  const tempDir = makeTempDir('paper-people-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'people@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'people@example.test', password: 'OwnerPass1234' }),
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

async function makeDepartment(ctx, name = 'Assembly') {
  const res = await api(ctx, 'POST', '/api/departments', { name });
  assert.equal(res.status, 201);
  return res.body.department;
}

test('people: departments are created, listed without the archived, renamed and refused a blank name', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));

  assert.equal((await api(ctx, 'POST', '/api/departments', { name: '   ' })).status, 400);

  const dept = await makeDepartment(ctx, '  Press Shop ');
  assert.equal(dept.name, 'Press Shop', 'the name is trimmed');
  assert.equal(dept.isArchived, false);

  const list = await api(ctx, 'GET', '/api/departments');
  assert.ok(list.body.departments.some((d) => d.id === dept.id));

  const renamed = await api(ctx, 'PATCH', `/api/departments/${dept.id}`, { description: 'Presses' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.department.description, 'Presses');
  assert.equal(renamed.body.department.name, 'Press Shop', 'what the patch did not mention is kept');

  assert.equal((await api(ctx, 'PATCH', '/api/departments/999999', { name: 'X' })).status, 404);

  await ctx.backend.run('UPDATE departments SET is_archived = 1 WHERE id = ?', [dept.id]);
  const after = await api(ctx, 'GET', '/api/departments');
  assert.ok(!after.body.departments.some((d) => d.id === dept.id), 'archived departments are not listed');
});

test('people: employees need a name and a department, keep what a patch leaves out, and read back joined to their login', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const dept = await makeDepartment(ctx);

  assert.equal((await api(ctx, 'POST', '/api/employees', { name: 'Asha' })).status, 400);
  assert.equal((await api(ctx, 'POST', '/api/employees', { departmentId: dept.id })).status, 400);

  const made = await api(ctx, 'POST', '/api/employees', {
    departmentId: dept.id,
    name: ' Asha Rao ',
    role: 'Fitter',
    phone: '9000000020',
    barcodeId: 'EMP-PEOPLE-1',
    dateOfBirth: '1990-03-15',
  });
  assert.equal(made.status, 201);
  const emp = made.body.employee;
  assert.equal(emp.name, 'Asha Rao');
  assert.equal(emp.employmentType, 'in-house');
  assert.equal(emp.status, 'active');
  assert.equal(emp.userId, null);
  assert.equal(emp.login, null);

  const list = await api(ctx, 'GET', '/api/employees');
  assert.ok(list.body.employees.some((e) => e.id === emp.id));

  const patched = await api(ctx, 'PATCH', `/api/employees/${emp.id}`, { phone: '9000000021' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.employee.phone, '9000000021');
  assert.equal(patched.body.employee.role, 'Fitter', 'what the patch did not mention is kept');
  assert.equal(patched.body.employee.barcodeId, 'EMP-PEOPLE-1');
  assert.equal(patched.body.employee.dateOfBirth, '1990-03-15');

  assert.equal((await api(ctx, 'PATCH', '/api/employees/999999', { phone: '1' })).status, 404);
});

test('people: deleting a department takes its employees with it, deleting an employee takes one', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const dept = await makeDepartment(ctx, 'Doomed');
  const other = await makeDepartment(ctx, 'Safe');
  const a = (await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name: 'A' })).body.employee;
  const b = (await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name: 'B' })).body.employee;
  const c = (await api(ctx, 'POST', '/api/employees', { departmentId: other.id, name: 'C' })).body.employee;

  assert.equal((await api(ctx, 'DELETE', `/api/employees/${c.id}`)).status, 200);
  let list = await api(ctx, 'GET', '/api/employees');
  assert.ok(!list.body.employees.some((e) => e.id === c.id));

  assert.equal((await api(ctx, 'DELETE', `/api/departments/${dept.id}`)).status, 200);
  list = await api(ctx, 'GET', '/api/employees');
  assert.ok(!list.body.employees.some((e) => e.id === a.id || e.id === b.id), 'the department\'s people went with it');
  const depts = await api(ctx, 'GET', '/api/departments');
  assert.ok(!depts.body.departments.some((d) => d.id === dept.id));
  assert.ok(depts.body.departments.some((d) => d.id === other.id));
});

test('people: an in-house employee is given a login whose code comes from the birth date, and it follows the date', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const dept = await makeDepartment(ctx);
  const emp = (await api(ctx, 'POST', '/api/employees', {
    departmentId: dept.id,
    name: 'Login Person',
    email: 'login.person@example.test',
    dateOfBirth: '1990-03-15',
  })).body.employee;

  const noEmail = await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name: 'No Mail' });
  assert.equal((await api(ctx, 'POST', `/api/employees/${noEmail.body.employee.id}/create-login`, { password: 'Str0ng!Passw0rd#1' })).status, 400);

  assert.equal((await api(ctx, 'POST', '/api/employees/999999/create-login', {})).status, 404);
  const asSuper = await api(ctx, 'POST', `/api/employees/${emp.id}/create-login`, {
    password: 'Str0ng!Passw0rd#1',
    role: 'super_admin',
  });
  assert.equal(asSuper.status, 403);
  assert.match(asSuper.body.error, /Cannot create a super admin/);

  const created = await api(ctx, 'POST', `/api/employees/${emp.id}/create-login`, {
    password: 'Str0ng!Passw0rd#1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.employee.login.email, 'login.person@example.test');
  assert.equal(created.body.employee.login.role, 'user', 'a staff login by default');
  assert.equal(created.body.employee.login.loginCode, '1503', 'DDMM of the birth date');
  assert.ok(created.body.employee.userId);

  const again = await api(ctx, 'POST', `/api/employees/${emp.id}/create-login`, { password: 'Str0ng!Passw0rd#1' });
  assert.equal(again.status, 409);

  const moved = await api(ctx, 'PATCH', `/api/employees/${emp.id}`, { dateOfBirth: '1991-07-02' });
  assert.equal(moved.body.employee.login.loginCode, '0207', 'a new birth date re-derives the code');

  const contractor = (await api(ctx, 'POST', '/api/employees', {
    departmentId: dept.id,
    name: 'Freelancer',
    employmentType: 'freelancer',
    email: 'free@example.test',
  })).body.employee;
  const refused = await api(ctx, 'POST', `/api/employees/${contractor.id}/create-login`, { password: 'Str0ng!Passw0rd#1' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Only in-house/);
});

test('people: an employee can be linked to an existing login, once, and unlinked', async (t) => {
  const ctx = await boot();
  t.after(() => closeServer(ctx.server));
  const dept = await makeDepartment(ctx);
  const one = (await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name: 'One', email: 'one@example.test' })).body.employee;
  const two = (await api(ctx, 'POST', '/api/employees', { departmentId: dept.id, name: 'Two', email: 'two@example.test' })).body.employee;

  const made = await api(ctx, 'POST', `/api/employees/${one.id}/create-login`, { password: 'Str0ng!Passw0rd#1' });
  const userId = made.body.employee.userId;

  assert.equal((await api(ctx, 'POST', `/api/employees/${two.id}/link-login`, {})).status, 400, 'userId is required');
  assert.equal((await api(ctx, 'POST', `/api/employees/${two.id}/link-login`, { userId: 999999 })).status, 404);
  assert.equal((await api(ctx, 'POST', '/api/employees/999999/link-login', { userId })).status, 404);

  const taken = await api(ctx, 'POST', `/api/employees/${two.id}/link-login`, { userId });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already linked to another employee/);

  const unlinked = await api(ctx, 'POST', `/api/employees/${one.id}/unlink-login`, {});
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.employee.userId, null);
  assert.equal(unlinked.body.employee.login, null);
  assert.equal((await api(ctx, 'POST', '/api/employees/999999/unlink-login', {})).status, 404);

  const linked = await api(ctx, 'POST', `/api/employees/${two.id}/link-login`, { userId });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.employee.userId, userId);
  assert.equal(linked.body.employee.login.email, 'one@example.test', 'the login keeps its own email');
});
