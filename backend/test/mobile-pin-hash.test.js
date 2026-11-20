'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');
const { createPinHasher, resolvePinKey } = require('../kernel/pin-hash');

// Staff login PINs are stored as a keyed hash (kernel/pin-hash.js): a stolen
// copy of paper.db no longer hands over every worker's PIN.

test('the hash is keyed: the same PIN under another key does not match, and the stored form is not the PIN', () => {
  const a = createPinHasher(resolvePinKey({ pinKey: 'key-a' }));
  const b = createPinHasher(resolvePinKey({ pinKey: 'key-b' }));
  assert.equal(a.hash('1503'), a.hash('1503'), 'deterministic, so one indexed lookup finds the account');
  assert.notEqual(a.hash('1503'), b.hash('1503'), 'without the key, a backup cannot be tried against');
  assert.notEqual(a.hash('1503'), a.hash('1504'));
  assert.match(a.hash('1503'), /^hmac1\$[0-9a-f]{64}$/);
  assert.ok(!a.hash('1503').includes('1503'));
  assert.ok(a.isPlain('0042') && !a.isPlain(a.hash('0042')));
  const derived = createPinHasher(resolvePinKey({ pinKey: '', jwtSecret: 'jwt' }));
  assert.notEqual(derived.hash('1503'), createPinHasher(Buffer.from('jwt')).hash('1503'),
    'derived from the JWT secret, not the JWT secret itself');
});

async function boot(t) {
  const tempDir = makeTempDir('paper-pin-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'pin-owner@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData('scenario_a');
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const owner = (await (await post('/api/auth/login', { email: 'pin-owner@paper.test', password: 'OwnerPass1234' })).json()).token;
  const pinStatus = async (pin) => (await post('/api/auth/login', { pin })).status;
  return { backend, baseUrl, post, owner, pinStatus };
}

test('a PIN stored plain before this change is hashed at boot, and still signs in', async (t) => {
  const ctx = await boot(t);
  const ownerRow = await ctx.backend.get("SELECT id FROM users WHERE email = 'pin-owner@paper.test'");
  await ctx.backend.run('UPDATE users SET mobile_pin = ? WHERE id = ?', ['4321', ownerRow.id]);

  await ctx.backend.initDb(); // the next start
  const stored = (await ctx.backend.get('SELECT mobile_pin FROM users WHERE id = ?', [ownerRow.id])).mobile_pin;
  assert.match(stored, /^hmac1\$/, 'no plain PIN is left in the table');
  assert.equal(await ctx.pinStatus('4321'), 200, 'the same four digits still sign in');
  assert.equal(await ctx.pinStatus('4322'), 401);

  await ctx.backend.initDb(); // and again: nothing to do
  assert.equal((await ctx.backend.get('SELECT mobile_pin FROM users WHERE id = ?', [ownerRow.id])).mobile_pin, stored);
  const plainLeft = await ctx.backend.get("SELECT COUNT(*) AS n FROM users WHERE mobile_pin GLOB '[0-9][0-9][0-9][0-9]'");
  assert.equal(Number(plainLeft.n), 0);
});

test('a new account shows its PIN once; afterwards only whether it has one; an admin issues a new one', async (t) => {
  const ctx = await boot(t);
  const made = await ctx.post('/api/users', { name: 'Press Operator', email: 'press@paper.test', password: 'PressPass12345!' }, ctx.owner);
  assert.equal(made.status, 201, await made.clone().text());
  const user = (await made.json()).user;
  assert.match(user.mobilePin, /^\d{4}$/, 'shown in the answer that made it');
  assert.equal(user.hasMobilePin, true);
  const stored = (await ctx.backend.get('SELECT mobile_pin FROM users WHERE id = ?', [user.id])).mobile_pin;
  assert.notEqual(stored, user.mobilePin);
  assert.notEqual(await ctx.pinStatus(user.mobilePin), 401, 'and it is the PIN that matches');

  const listed = await (await fetch(`${ctx.baseUrl}/api/users`, { headers: { Authorization: `Bearer ${ctx.owner}` } })).json();
  const again = (listed.users || listed.data || []).find((u) => u.id === user.id);
  assert.ok(again, JSON.stringify(Object.keys(listed)));
  assert.equal(again.mobilePin, undefined, 'never sent again — not the PIN, not its hash');
  assert.equal(again.hasMobilePin, true);
  assert.ok(!JSON.stringify(listed).includes('hmac1$'), 'no hash leaves the server either');

  const issued = await ctx.post(`/api/users/${user.id}/mobile-pin`, {}, ctx.owner);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { pin } = await issued.json();
  assert.match(pin, /^\d{4}$/);
  assert.notEqual(await ctx.pinStatus(pin), 401, 'the new PIN signs in');
  if (pin !== user.mobilePin) assert.equal(await ctx.pinStatus(user.mobilePin), 401, 'the old one no longer does');

  const ownerRow = await ctx.backend.get("SELECT id FROM users WHERE email = 'pin-owner@paper.test'");
  assert.equal((await ctx.post('/api/users/999999/mobile-pin', {}, ctx.owner)).status, 404);
  const pressToken = (await (await ctx.post('/api/auth/login', { email: 'press@paper.test', password: 'PressPass12345!' })).json()).token;
  assert.ok(pressToken, 'the staff account can sign in, so the refusal below is really tested');
  const refused = await ctx.post(`/api/users/${ownerRow.id}/mobile-pin`, {}, pressToken);
  assert.equal(refused.status, 403, 'staff cannot issue the owner a PIN');
});
