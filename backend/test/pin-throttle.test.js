'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');
const { createPinThrottle } = require('../kernel/pin-throttle');

// B59: PIN guessing slowed per address, never locked per address — twenty
// phones behind one factory router share one (kernel/pin-throttle.js).

function throttle() {
  let clock = 1_000_000;
  const slept = [];
  const t = createPinThrottle({ now: () => clock, sleep: async (ms) => { slept.push(ms); } });
  return { t, slept, advance: (ms) => { clock += ms; } };
}

test('15 wrong PINs a minute are answered; the 16th gets 429 for a minute, then guessing may resume', async () => {
  const { t, slept, advance } = throttle();
  for (let i = 0; i < 15; i += 1) {
    const ticket = t.begin('10.0.0.5');
    assert.equal(ticket.blocked, false, `attempt ${i + 1}`);
    await t.failed(ticket);
    advance(1000);
  }
  assert.deepEqual(slept, Array(15).fill(1000), 'each wrong PIN waited a second (the tarpit)');
  const tripped = t.begin('10.0.0.5');
  assert.deepEqual(tripped, { blocked: true, started: true, retryAfterSeconds: 60 });
  advance(30 * 1000);
  const still = t.begin('10.0.0.5');
  assert.equal(still.blocked, true);
  assert.equal(still.started, undefined, 'logged once, when it trips');
  assert.equal(still.retryAfterSeconds, 30);
  advance(30 * 1000);
  assert.equal(t.begin('10.0.0.5').blocked, false, 'a minute later, and the old attempts out of the window');
});

test('a shift change does not trip it: right PINs give their place back, mistakes spread out roll off', async () => {
  const { t, advance } = throttle();
  for (let i = 0; i < 100; i += 1) {
    const ticket = t.begin('10.0.0.1'); // twenty phones, one router
    assert.equal(ticket.blocked, false);
    t.succeeded(ticket);
  }
  for (let i = 0; i < 40; i += 1) {
    const ticket = t.begin('10.0.0.1');
    assert.equal(ticket.blocked, false, `mistake ${i + 1}, one every 5 s`);
    await t.failed(ticket);
    advance(5000); // 12 a minute: under 15
  }
});

test('a script sending at once is stopped at once: attempts count from when they arrive', () => {
  const { t } = throttle();
  const tickets = Array.from({ length: 40 }, () => t.begin('203.0.113.9'));
  assert.equal(tickets.filter((x) => !x.blocked).length, 15, 'fifteen pending, the rest refused before any finished');
  assert.equal(t.begin('198.51.100.2').blocked, false, 'another address is untouched');
});

async function boot(t) {
  const tempDir = makeTempDir('paper-pin-throttle-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'throttle-owner@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  process.env.PAPER_PIN_TARPIT_MS = '150';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  delete process.env.PAPER_PIN_TARPIT_MS;
  await backend.resetAndSeedDemoData('scenario_a');
  const owner = await backend.get("SELECT id FROM users WHERE email = 'throttle-owner@paper.test'");
  await backend.run('UPDATE users SET mobile_pin = ? WHERE id = ?', ['4321', owner.id]);
  await backend.initDb(); // hashes it
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const pin = async (value) => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: value }),
    });
    return { status: response.status, ms: Date.now() - started, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  };
  return { backend, pin };
}

test('the server: a wrong PIN waits, a burst is refused with 429, and while refused a right PIN is too', async (t) => {
  const ctx = await boot(t);
  const right = await ctx.pin('4321');
  assert.equal(right.status, 200);

  const wrong = await ctx.pin('0000');
  assert.equal(wrong.status, 401);
  assert.ok(wrong.ms >= 140, `a wrong PIN is answered after the tarpit (${wrong.ms} ms)`);

  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.pin(String(1000 + i))));
  const answered = burst.filter((r) => r.status === 401).length;
  const refused = burst.filter((r) => r.status === 429);
  assert.equal(answered + 1, 15, 'fifteen a minute from one address, the one before included');
  assert.equal(refused.length, 30 - answered);
  assert.equal(refused[0].retryAfter, '60');
  assert.match(refused[0].body.error, /Too many wrong PINs from this network/);

  const meanwhile = await ctx.pin('4321');
  assert.equal(meanwhile.status, 429, 'refused too — a right answer while blocked would tell a script which PIN is right');
  const logged = await ctx.backend.get("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'login_pin_throttled'");
  assert.equal(Number(logged.n), 1, 'one log line for the block, not one per refused request');
});
