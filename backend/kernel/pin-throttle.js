'use strict';

// Slows PIN guessing without locking a factory floor out (B59).
//
// A PIN is four digits and the whole identity at sign-in, so a wrong one
// matches no account and no per-account lockout can apply. An IP lockout would
// be wrong too: twenty phones behind one factory router share an address, and
// a few mistyped PINs would lock all of them out.
//
// So two softer limits, per address:
//
//   tarpit   a wrong PIN is answered after `delayMs` (1 s). A worker who
//            mistypes barely notices; a script trying 10,000 PINs one at a
//            time takes 10,000 s.
//   window   at most `maxAttempts` (15) wrong-or-pending PIN attempts per
//            rolling `windowMs` (60 s). Past it, every PIN attempt from that
//            address — right or wrong, so the answers reveal nothing — gets
//            429 with Retry-After for `blockMs` (60 s). A shift change does
//            not reach 15 mistakes a minute; a script does at once.
//
// An attempt takes its place in the window when it ARRIVES and gives it back
// only if the PIN was right. Counting failures as they finish would let a
// script send a hundred at once, all checked against an empty window.
//
// Together: one address tries at most 15 PINs a minute, so all 10,000 take
// over 11 hours — against ~10,000 / N for N staff on average. It does not stop
// guessing spread over many addresses; nothing per-address can.
//
// In memory, one process: a restart forgets it, which costs an attacker a
// minute at most.

function createPinThrottle({
  now = () => Date.now(),
  delayMs = 1000,
  windowMs = 60 * 1000,
  maxAttempts = 15,
  blockMs = 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  /// address -> { attempts: number[] (times), blockedUntil: number }
  const byAddress = new Map();
  let sweeps = 0;

  function entry(address) {
    let e = byAddress.get(address);
    if (!e) {
      e = { attempts: [], blockedUntil: 0 };
      byAddress.set(address, e);
    }
    return e;
  }

  function prune(e, at) {
    while (e.attempts.length && e.attempts[0] <= at - windowMs) e.attempts.shift();
  }

  /// Drops addresses with nothing left to remember, now and then, so the map
  /// cannot grow without bound.
  function sweep(at) {
    sweeps += 1;
    if (sweeps % 256 !== 0) return;
    for (const [address, e] of byAddress) {
      prune(e, at);
      if (!e.attempts.length && e.blockedUntil <= at) byAddress.delete(address);
    }
  }

  /// A PIN attempt from `address` arrives. Either `{ blocked: true,
  /// retryAfterSeconds }`, or a ticket to settle with `succeeded` / `failed`.
  function begin(address) {
    const at = now();
    sweep(at);
    const key = String(address || 'unknown');
    const e = entry(key);
    prune(e, at);
    if (e.blockedUntil > at) {
      return { blocked: true, retryAfterSeconds: Math.ceil((e.blockedUntil - at) / 1000) };
    }
    if (e.attempts.length >= maxAttempts) {
      e.blockedUntil = at + blockMs;
      // `started`: this request is the one that tripped it — worth one log line.
      return { blocked: true, started: true, retryAfterSeconds: Math.ceil(blockMs / 1000) };
    }
    e.attempts.push(at);
    return { blocked: false, key, at };
  }

  /// The PIN was right: its place in the window is given back.
  function succeeded(ticket) {
    if (!ticket || ticket.blocked) return;
    const e = byAddress.get(ticket.key);
    if (!e) return;
    const i = e.attempts.indexOf(ticket.at);
    if (i > -1) e.attempts.splice(i, 1);
  }

  /// The PIN was wrong: it keeps its place, and the answer waits `delayMs`.
  async function failed(ticket) {
    if (!ticket || ticket.blocked) return;
    if (delayMs > 0) await sleep(delayMs);
  }

  function attemptsFor(address) {
    const e = byAddress.get(String(address || 'unknown'));
    if (!e) return 0;
    prune(e, now());
    return e.attempts.length;
  }

  return { begin, succeeded, failed, attemptsFor };
}

module.exports = { createPinThrottle };
