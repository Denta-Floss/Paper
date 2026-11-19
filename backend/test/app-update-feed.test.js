const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// B32. The desktop app's update feed is two server settings, answered to a
// signed-in app; with either unset there is nothing to offer.

async function boot(env) {
  const tempDir = makeTempDir('paper-update-feed-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'feed@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'feed@example.test', password: 'OwnerPass1234' }),
  }).then((r) => r.json());
  return { server, baseUrl, token: login.token };
}

test('the feed answers the version and link the server is set to, and only to a signed-in app', async (t) => {
  const ctx = await boot({ PAPER_DESKTOP_LATEST_VERSION: '1.0.412', PAPER_DESKTOP_DOWNLOAD_URL: 'https://example.test/1.0.412/paper.exe' });
  t.after(() => ctx.server.close());
  const anonymous = await fetch(`${ctx.baseUrl}/api/app/latest`);
  assert.equal(anonymous.status, 401);
  const res = await fetch(`${ctx.baseUrl}/api/app/latest`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true, latestVersion: '1.0.412', downloadUrl: 'https://example.test/1.0.412/paper.exe', error: null,
  });
});

test('with nothing set there is no update to offer', async (t) => {
  const ctx = await boot({ PAPER_DESKTOP_LATEST_VERSION: undefined, PAPER_DESKTOP_DOWNLOAD_URL: undefined });
  t.after(() => ctx.server.close());
  const res = await fetch(`${ctx.baseUrl}/api/app/latest`, { headers: { Authorization: `Bearer ${ctx.token}` } });
  assert.deepEqual(await res.json(), { success: true, latestVersion: null, downloadUrl: null, error: null });
});
