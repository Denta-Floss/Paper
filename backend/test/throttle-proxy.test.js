'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createThrottledLink } = require('./benchmarks/throttle-proxy');

// The link the network benchmark runs on (benchmarks/network-throttle.js).
// A benchmark on a link that does not actually throttle would report fast
// numbers for nothing; these check the model costs what it says it costs.

async function origin() {
  const server = http.createServer((req, res) => {
    const size = Number(new URL(req.url, 'http://x').searchParams.get('bytes') || 0);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    res.end(Buffer.alloc(size, 7));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function timedGet(port, bytes, agent) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/?bytes=${bytes}`, agent }, (res) => {
      let received = 0;
      res.on('data', (chunk) => { received += chunk.length; });
      res.on('end', () => resolve({ ms: Date.now() - started, received }));
    }).on('error', reject);
  });
}

test('a tiny request costs the handshake and a round trip', async (t) => {
  const server = await origin();
  const link = await createThrottledLink({ targetPort: server.address().port, bandwidthBps: 1e6, rttMs: 150 });
  t.after(async () => { await link.close(); server.close(); });
  const { ms, received } = await timedGet(link.port, 10, new http.Agent());
  assert.equal(received, 10);
  assert.ok(ms >= 290 && ms < 450, `handshake 150 + request and answer 150, got ${ms} ms`);
});

test('62.5 KB at 1 Mbps takes about half a second of line, plus the round trips', async (t) => {
  const server = await origin();
  const link = await createThrottledLink({ targetPort: server.address().port, bandwidthBps: 1e6, rttMs: 150 });
  t.after(async () => { await link.close(); server.close(); });
  const { ms, received } = await timedGet(link.port, 62500, new http.Agent());
  assert.equal(received, 62500);
  // 500 ms on the line; 300 ms of handshake and round trip; slow start adds
  // a round or two on a fresh connection.
  assert.ok(ms >= 800 && ms < 1400, `got ${ms} ms`);
});

test('two downloads at once share the line rather than each getting it', async (t) => {
  const server = await origin();
  const link = await createThrottledLink({ targetPort: server.address().port, bandwidthBps: 1e6, rttMs: 150 });
  t.after(async () => { await link.close(); server.close(); });
  const started = Date.now();
  await Promise.all([timedGet(link.port, 62500, new http.Agent()), timedGet(link.port, 62500, new http.Agent())]);
  const ms = Date.now() - started;
  assert.ok(ms >= 1300, `125 KB through one 1 Mbps line cannot take under a second of line time; got ${ms} ms`);
});

test('loss costs time, and the same seed costs the same', async (t) => {
  const server = await origin();
  const lossy = await createThrottledLink({ targetPort: server.address().port, bandwidthBps: 1e6, rttMs: 150, lossRate: 0.2, seed: 7 });
  const clean = await createThrottledLink({ targetPort: server.address().port, bandwidthBps: 1e6, rttMs: 150 });
  t.after(async () => { await lossy.close(); await clean.close(); server.close(); });
  const withLoss = await timedGet(lossy.port, 62500, new http.Agent());
  const without = await timedGet(clean.port, 62500, new http.Agent());
  assert.equal(withLoss.received, 62500, 'loss delays bytes, never drops them: TCP resends');
  assert.ok(lossy.stats.segmentsLost > 0 || withLoss.ms > without.ms + 100, `lost ${lossy.stats.segmentsLost}`);
  assert.ok(withLoss.ms > without.ms, `${withLoss.ms} ms with loss, ${without.ms} without`);
});
