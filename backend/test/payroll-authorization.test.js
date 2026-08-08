const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Regression: payroll used to be UNCLAIMED territory. Its routes carry
// requirePermission('config.read'), which is a documented no-op (config.* is in
// LEGACY_GUARD_PASSTHROUGH) because enforcement was supposed to move to the
// central per-module gate — but with no manifest entry, moduleOpForRequest
// returned null and no module gate ran either. Net effect: ANY authenticated
// user could read salary components, structures and payroll runs.
//
// Payroll is now a declared module marked `sensitive`, so staff do not even get
// read by default. This test pins both halves: staff denied, admin allowed.

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

test('payroll data is not readable without an explicit grant', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-payroll-authz-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'payroll-owner@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  // Give the probe something real to leak, so this measures AUTHORIZATION
  // rather than a missing table. The table itself now comes from initDb's
  // bootstrap parity with migrations/005 — this test used to have to invent it,
  // which is how it ended up asserting against a schema that did not exist.
  await backend.run(
    `INSERT INTO payroll_components (name, type, calculation_method, config_json)
     VALUES ('Basic Salary', 'earning', 'fixed', '{"value":50000}')`,
  );

  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = async (email, password) =>
    (
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    ).json();
  const authed = (token) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  try {
    const owner = await login('payroll-owner@paper.local', 'OwnerPass1234');
    assert.ok(owner.token, 'expected owner login');

    await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: authed(owner.token),
      body: JSON.stringify({
        name: 'Floor Staff',
        email: 'floor@paper.local',
        password: 'FloorPass1234',
        role: 'user',
      }),
    });
    const staff = await login('floor@paper.local', 'FloorPass1234');
    assert.ok(staff.token, 'expected staff login');

    // Staff must not inherit payroll.read the way they inherit other modules.
    // `permissions` is the list of GRANTED keys.
    const staffPerms = staff.user?.permissions || [];
    assert.ok(
      !staffPerms.includes('payroll.read'),
      'staff must not get payroll.read by default',
    );
    // Sanity: they DO still inherit ordinary module reads, so this is a
    // targeted exclusion rather than a broken default.
    assert.ok(
      staffPerms.includes('items.read'),
      'staff should still inherit ordinary module reads',
    );

    const leak = await fetch(`${baseUrl}/api/payroll/components`, {
      headers: authed(staff.token),
    });
    assert.equal(leak.status, 403, 'staff must be refused payroll data');
    const leakBody = await leak.json();
    assert.ok(
      !JSON.stringify(leakBody).includes('50000'),
      'salary values must never appear in a refused response',
    );

    // The owner still gets through — the gate must not be a wall.
    const allowed = await fetch(`${baseUrl}/api/payroll/components`, {
      headers: authed(owner.token),
    });
    assert.equal(allowed.status, 200, 'super admin must still read payroll');
    const allowedBody = await allowed.json();
    assert.ok(
      allowedBody.components.some((c) => String(c.config_json || '').includes('50000')),
      'expected the seeded component for an authorized reader',
    );

    // And an explicit grant restores access for staff — need-to-know, not never.
    await fetch(`${baseUrl}/api/users/${staff.user.id}/permissions`, {
      method: 'PATCH',
      headers: authed(owner.token),
      body: JSON.stringify({
        overrides: [{ key: 'payroll.read', allowed: true }],
      }),
    });
    const granted = await login('floor@paper.local', 'FloorPass1234');
    const afterGrant = await fetch(`${baseUrl}/api/payroll/components`, {
      headers: authed(granted.token),
    });
    assert.equal(afterGrant.status, 200, 'an explicit payroll.read grant must work');
  } finally {
    await closeServer(server);
    await backend.closeDb?.();
  }
});
