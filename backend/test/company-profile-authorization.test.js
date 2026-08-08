const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mkdtempSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('company-profile is sensitive-gated and cannot be escalated via inventory.update', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-cp-auth-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'admin@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'AdminPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const { server, port } = await listen(backend.app);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Super admin login
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@paper.local',
        password: 'AdminPass1234',
      }),
    });
    const { token: adminToken } = await adminLoginRes.json();
    assert.ok(adminToken, 'expected admin login token');

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    };

    // 2. Create a staff user
    const createStaffRes = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Warehouse Operator',
        email: 'operator@paper.local',
        password: 'OperatorPass123',
        role: 'user',
      }),
    });
    const staffUser = await createStaffRes.json();
    assert.equal(staffUser.success, true);
    const staffUserId = staffUser.user?.id || staffUser.id;

    // Grant ONLY inventory.update to the staff user
    await fetch(`${baseUrl}/api/users/${staffUserId}/permissions`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        overrides: [{ key: 'inventory.update', allowed: true }],
      }),
    });

    // 3. Staff user login
    const staffLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'operator@paper.local',
        password: 'OperatorPass123',
      }),
    });
    const { token: staffToken } = await staffLoginRes.json();
    assert.ok(staffToken, 'expected staff login token');

    const staffHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${staffToken}`,
    };

    // 4. Staff cannot read sensitive company-profile (403)
    const staffGetRes = await fetch(`${baseUrl}/api/company-profile`, {
      headers: staffHeaders,
    });
    assert.equal(
      staffGetRes.status,
      403,
      'staff with only inventory.update must be blocked from reading company-profile',
    );

    // 5. Staff cannot escalate and update company-profile (403)
    const staffPutRes = await fetch(`${baseUrl}/api/company-profile`, {
      method: 'PUT',
      headers: staffHeaders,
      body: JSON.stringify({
        company_name: 'Shree Ganesh Metal Works [ESCALATED]',
        gstin: '27ABCDE1234F1Z5',
      }),
    });
    assert.equal(
      staffPutRes.status,
      403,
      'staff with only inventory.update must be blocked from modifying company-profile',
    );

    // 6. Admin can read and update company profile
    const adminPutRes = await fetch(`${baseUrl}/api/company-profile`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        company_name: 'Legitimate Company Name',
        gstin: '27AAAAA0000A1Z5',
      }),
    });
    assert.equal(adminPutRes.status, 200);

    const adminGetRes = await fetch(`${baseUrl}/api/company-profile`, {
      headers: adminHeaders,
    });
    const profileData = await adminGetRes.json();
    assert.equal(profileData.success, true);
    assert.equal(profileData.data?.company_name || profileData.data?.companyName, 'Legitimate Company Name');

    // 7. Test unauthenticated portal login endpoint
    const portalLoginRes = await fetch(`${baseUrl}/api/portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password',
      }),
    });
    assert.equal(
      portalLoginRes.status,
      200,
      'POST /api/portal/login must be accessible without prior ERP bearer token',
    );

    // 8. Test unauthenticated freelancer-portal token endpoint
    const SECRET = 'my-very-secret-key-32charslong!!';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET), iv);
    let encrypted = cipher.update('non-existent-barcode');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const validEncryptedToken = `${iv.toString('hex')}:${encrypted.toString('hex')}`;

    const freelancerRes = await fetch(
      `${baseUrl}/api/freelancer-portal/data?token=${encodeURIComponent(validEncryptedToken)}`,
    );
    // Should return 404 for unknown barcode, NOT 401 Authentication Required
    assert.equal(
      freelancerRes.status,
      404,
      'GET /api/freelancer-portal/data must process the query token without 401 auth gate',
    );
  } finally {
    await closeServer(server);
    await backend.closeDb?.();
  }
});
