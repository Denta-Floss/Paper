'use strict';

// Staff login PINs, stored as a keyed hash.
//
// A PIN is four digits: 10,000 possibilities. A per-user salted hash (pbkdf2,
// scrypt) of something that small falls to anyone holding the database in
// minutes — try all 10,000 against each row — so on its own it protects a
// stolen paper.db backup hardly at all. What does protect it is a key the
// database does not contain: HMAC-SHA256 under PAPER_PIN_KEY (or, when that is
// unset, a key derived from PAPER_JWT_SECRET), both of which live in the
// server's environment, never in the file a backup copies.
//
// The hash is deterministic on purpose. A PIN is the whole identity at sign-in
// ("which user has 1503?") and must stay unique across users; a keyed hash
// keeps both a single indexed lookup and the existing unique index on
// users.mobile_pin, where a salted hash would need every row tried.
//
// The cost of hashing at all: the server can no longer show anyone a PIN. It
// is shown once, when it is issued; after that an admin issues a new one.
//
// Rotating the key (or PAPER_JWT_SECRET while PAPER_PIN_KEY is unset) makes
// every stored PIN stop matching: staff then need new PINs. Set PAPER_PIN_KEY
// in production so the two secrets rotate separately.

const crypto = require('node:crypto');

const PREFIX = 'hmac1$';
const PLAIN_PIN = /^\d{4}$/;

function resolvePinKey({ pinKey = process.env.PAPER_PIN_KEY, jwtSecret } = {}) {
  const configured = String(pinKey || '').trim();
  if (configured) return Buffer.from(configured, 'utf8');
  // Derived, so the PIN key is never the JWT signing key itself.
  return crypto.createHmac('sha256', String(jwtSecret || '')).update('paper:mobile-pin-key:v1').digest();
}

function createPinHasher(key) {
  if (!key || !key.length) throw new Error('A PIN key is required.');

  /// The stored form of a 4-digit PIN.
  function hash(pin) {
    const value = String(pin ?? '').trim();
    return PREFIX + crypto.createHmac('sha256', key).update(`paper:mobile-pin:v1:${value}`).digest('hex');
  }

  /// Whether a stored value is still a plain PIN from before hashing.
  function isPlain(stored) {
    return typeof stored === 'string' && PLAIN_PIN.test(stored);
  }

  function isHashed(stored) {
    return typeof stored === 'string' && stored.startsWith(PREFIX);
  }

  /// Hashes every plain PIN left in the users table, once, at boot. Returns
  /// how many it changed. Idempotent: hashed rows are left alone.
  async function migrate({ all, run }) {
    const rows = await all("SELECT id, mobile_pin FROM users WHERE mobile_pin IS NOT NULL AND mobile_pin NOT LIKE 'hmac1$%'");
    let changed = 0;
    for (const row of rows) {
      if (!isPlain(row.mobile_pin)) continue;
      await run('UPDATE users SET mobile_pin = ? WHERE id = ?', [hash(row.mobile_pin), row.id]);
      changed += 1;
    }
    return changed;
  }

  return { hash, isPlain, isHashed, migrate };
}

module.exports = { createPinHasher, resolvePinKey, PREFIX };
