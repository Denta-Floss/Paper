const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Two route handlers shipped calling functions that do not exist anywhere —
// `await prepare(...)` in PUT /api/invoices/:id and
// `await handleAssetUploadComplete(...)` in the challan asset upload-complete
// route. Both threw ReferenceError on every request, so those endpoints could
// never succeed. Nothing caught it: the calls sit inside `try` blocks that
// report the error as a generic 500, and no test exercised those routes.
//
// Scope note: this scans `await name(...)` specifically. That is the form both
// real defects took, and unlike a bare `name(` scan it cannot be confused by
// SQL identifiers inside template literals (`INSERT INTO auth_events (`), which
// are never preceded by `await`. Narrow and reliable beats broad and flaky —
// a guard-rail that cries wolf gets deleted.

const SERVER = path.join(__dirname, '../server.js');

function definedNames(source) {
  const defined = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g,
    /(?:^|\n)\s*class\s+([A-Za-z0-9_$]+)/g,
    /(?:^|\n)\s*(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      for (const piece of match[1].split(',')) {
        const name = piece.includes(':') ? piece.split(':')[1] : piece;
        const clean = name.replace(/=.*/, '').trim();
        if (/^[A-Za-z0-9_$]+$/.test(clean)) defined.add(clean);
      }
    }
  }
  return defined;
}

test('every awaited function call in server.js resolves to something', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  const defined = definedNames(source);
  const globals = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    'require', 'fetch', 'structuredClone', 'queueMicrotask',
  ]);

  const unresolved = new Map();
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const match = /(?:^|[^.\w$])await\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line);
    if (!match) return;
    const name = match[1];
    if (defined.has(name) || globals.has(name)) return;
    // Locally-bound names (parameters, destructured results, callbacks) appear
    // as bindings elsewhere in the file.
    const bound = new RegExp(
      `(?:\\(|,|\\{|\\bconst\\s|\\blet\\s|\\bvar\\s)\\s*${name}\\s*(?:,|\\)|\\}|=|:)`,
    ).test(source);
    if (bound) return;
    if (!unresolved.has(name)) unresolved.set(name, index + 1);
  });

  const report = [...unresolved].map(([name, line]) => `${name}() at server.js:${line}`);
  assert.deepEqual(
    report,
    [],
    `These awaited calls resolve to nothing and throw ReferenceError at runtime:\n  ${report.join('\n  ')}`,
  );
});

test('the two known-broken calls are gone', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  assert.ok(
    !/\bawait\s+prepare\s*\(/.test(source),
    'PUT /api/invoices/:id must not call the non-existent prepare()',
  );
  assert.ok(
    !/\bhandleAssetUploadComplete\s*\(/.test(source),
    'the challan asset route must not call the non-existent handleAssetUploadComplete()',
  );
});
