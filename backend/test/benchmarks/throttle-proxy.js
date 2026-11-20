'use strict';

// A shop-floor link in front of a local server: a TCP proxy that makes bytes
// cost what they cost on a slow line.
//
// Modelled, per link (all connections through it share it, as they share a
// factory's one line):
//
//   bandwidth    each direction is a queue drained at `bandwidthBps`; a chunk
//                leaves when the line is free and has taken its serialisation
//                time (bytes × 8 / bandwidth)
//   latency      half the round trip each way, after serialisation
//   handshake    a new connection carries nothing for one round trip (SYN,
//                SYN-ACK) before its first byte goes
//   slow start   a new connection may have 10 segments in flight, doubling each
//                round trip (RFC 6928's initial window), so a fresh connection
//                does not get the whole line at once
//   loss         each 1448-byte segment is lost with probability `lossRate`;
//                a lost segment is sent again one round trip later (fast
//                retransmit), costs the line its bytes again, and holds up what
//                follows it on that connection — head-of-line blocking, which
//                is how loss is felt by an app above TCP
//
// Not modelled: the operating system's real TCP behind it (the proxy speaks
// loopback both sides, where the real cost is nil), congestion-window collapse
// after loss, jitter. The numbers are a model's, stated as such where they are
// reported.

const net = require('node:net');

const MSS = 1448;
const INITIAL_WINDOW = 10 * MSS;

/// Deterministic, so a run is repeatable: mulberry32.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Line {
  constructor(bandwidthBps) {
    this.bytesPerMs = bandwidthBps / 8 / 1000;
    this.freeAt = 0;
  }

  /// When `bytes` handed over at `readyAt` have finished leaving.
  occupy(readyAt, bytes) {
    const start = Math.max(readyAt, this.freeAt);
    this.freeAt = start + bytes / this.bytesPerMs;
    return this.freeAt;
  }
}

/// One direction of one connection: its slow-start window and the order its
/// bytes must arrive in.
class Flow {
  constructor({ line, rttMs, lossRate, random, opensAt }) {
    this.line = line;
    this.rttMs = rttMs;
    this.lossRate = lossRate;
    this.random = random;
    this.window = INITIAL_WINDOW;
    this.roundStart = opensAt;
    this.inRound = 0;
    this.lastArrival = opensAt;
    this.segmentsLost = 0;
  }

  /// When a chunk handed over now reaches the far end.
  schedule(now, bytes) {
    let arrival = this.lastArrival;
    let remaining = bytes;
    while (remaining > 0) {
      const segment = Math.min(MSS, remaining);
      remaining -= segment;
      // A round begins when its first segment goes, not when the connection
      // opened: dating it earlier would let rounds "pass" before any data
      // moved and hide slow start.
      if (this.inRound === 0) this.roundStart = Math.max(this.roundStart, now);
      // The window is full: this segment waits for the round's acknowledgements,
      // and the next round may carry twice as much.
      if (this.inRound + segment > this.window) {
        this.roundStart = Math.max(this.roundStart + this.rttMs, now);
        this.inRound = 0;
        this.window *= 2;
      }
      this.inRound += segment;
      let leaves = this.line.occupy(Math.max(now, this.roundStart), segment);
      if (this.lossRate > 0 && this.random() < this.lossRate) {
        this.segmentsLost += 1;
        leaves = this.line.occupy(leaves + this.rttMs, segment);
      }
      arrival = Math.max(arrival, leaves + this.rttMs / 2);
    }
    this.lastArrival = arrival;
    return arrival;
  }
}

/// Starts a throttled link to `targetPort`. Returns the port to connect to.
async function createThrottledLink({
  targetPort,
  targetHost = '127.0.0.1',
  bandwidthBps,
  rttMs,
  lossRate = 0,
  seed = 1,
}) {
  const down = new Line(bandwidthBps);
  const up = new Line(bandwidthBps);
  const random = seeded(seed);
  const stats = { connections: 0, bytesDown: 0, bytesUp: 0, segmentsLost: 0 };
  const sockets = new Set();

  const server = net.createServer((client) => {
    stats.connections += 1;
    sockets.add(client);
    // The handshake: nothing moves for one round trip.
    const opensAt = Date.now() + rttMs;
    const upstream = net.connect(targetPort, targetHost);
    sockets.add(upstream);
    const toServer = new Flow({ line: up, rttMs, lossRate, random, opensAt });
    const toClient = new Flow({ line: down, rttMs, lossRate, random, opensAt });

    const relay = (from, to, flow, counter) => {
      from.on('data', (chunk) => {
        stats[counter] += chunk.length;
        const arrival = flow.schedule(Date.now(), chunk.length);
        const wait = Math.max(0, arrival - Date.now());
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, wait);
      });
      from.on('end', () => {
        const wait = Math.max(0, flow.lastArrival - Date.now());
        setTimeout(() => to.end(), wait);
      });
      from.on('error', () => to.destroy());
      from.on('close', () => sockets.delete(from));
    };
    relay(client, upstream, toServer, 'bytesUp');
    relay(upstream, client, toClient, 'bytesDown');
    client.on('close', () => {
      stats.segmentsLost += toServer.segmentsLost + toClient.segmentsLost;
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    stats,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

module.exports = { createThrottledLink, MSS, INITIAL_WINDOW };
