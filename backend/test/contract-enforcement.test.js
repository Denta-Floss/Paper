const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Contract guards have two deliberate modes. This file pins the ENFORCING one
// (PAPER_CONTRACT_ENFORCE=1); the log-only default is covered in
// items-module.test.js. The flag is read when server.js loads, so enforcement
// gets its own process/file rather than being toggled mid-suite.

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

test('PAPER_CONTRACT_ENFORCE=1 turns contract violations into 400s', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-contract-enforce-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'enforce@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  process.env.PAPER_CONTRACT_ENFORCE = '1';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'enforce@paper.local', password: 'OwnerPass1234' }),
    });
    const { token } = await login.json();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    const groups = await (await fetch(`${baseUrl}/api/groups`, { headers })).json();
    const group = groups.groups.find((g) => g.unitId);
    assert.ok(group, 'expected a seeded group with a unit');

    // A structurally impossible payload: no name, no owner group.
    const bad = await fetch(`${baseUrl}/api/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ unitId: group.unitId }),
    });
    assert.equal(bad.status, 400, 'enforcing mode must refuse');
    const badBody = await bad.json();
    assert.equal(badBody.error, 'Contract violation');
    assert.ok(Array.isArray(badBody.alerts) && badBody.alerts.length > 0);
    assert.ok(badBody.alerts.some((a) => a.path === 'item.name'));

    // Representation tolerance still holds while enforcing: numeric strings and
    // absent optionals are how these handlers have always been fed.
    const tolerated = await fetch(`${baseUrl}/api/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Enforced Tolerant Item',
        groupId: String(group.id),
        unitId: String(group.unitId),
        quantity: '0',
      }),
    });
    assert.equal(
      tolerated.status,
      201,
      'numeric strings must be tolerated even when enforcing',
    );

    const alerts = await (
      await fetch(`${baseUrl}/api/kernel/guard-alerts`, { headers })
    ).json();
    assert.equal(alerts.enforcing, true);
    assert.ok(
      alerts.alerts.some((a) => a.details && a.details.enforced === true),
      'refusals must still be filed as alerts',
    );
  } finally {
    delete process.env.PAPER_CONTRACT_ENFORCE;
    await closeServer(server);
    await backend.closeDb?.();
  }
});
