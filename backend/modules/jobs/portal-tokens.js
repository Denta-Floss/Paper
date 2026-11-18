'use strict';

// ---------------------------------------------------------------------------
// The token on a freelancer's printed job card.
//
// A card carries a link; the link carries this token; the token says which
// worker's card it is. It is the worker's barcode with a signature only this
// server can make:
//
//   v2.<barcode, base64url>.<HMAC-SHA256 of the barcode, base64url>
//
// The key is derived from the server's own secret (PAPER_JWT_SECRET), so it
// differs per installation and is never in the source or in the app. Anyone
// can read the barcode out of a token; nobody without the secret can make a
// token for a different barcode, which is the point.
//
// A token does not expire: a card is paper and is used until its batch is
// done. Changing the server's secret voids every card.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

function createPortalTokens({ secret }) {
  if (!secret) throw new Error('portal tokens need the server secret');
  const key = crypto.createHmac('sha256', String(secret)).update('freelancer-portal-token').digest();
  const sign = (barcodeId) => crypto.createHmac('sha256', key).update(barcodeId).digest('base64url');

  return {
    make(barcodeId) {
      const value = String(barcodeId);
      return `v2.${Buffer.from(value, 'utf8').toString('base64url')}.${sign(value)}`;
    },

    /// The barcode a token is for, or null when it is not one this server made.
    read(token) {
      const parts = String(token || '').split('.');
      if (parts.length !== 3 || parts[0] !== 'v2') return null;
      const barcodeId = Buffer.from(parts[1], 'base64url').toString('utf8');
      if (!barcodeId) return null;
      const given = Buffer.from(parts[2]);
      const expected = Buffer.from(sign(barcodeId));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      return barcodeId;
    },
  };
}

module.exports = { createPortalTokens };
