const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// A test that names a path on one person's machine passes there and nowhere
// else. Two did: they loaded the server from /Users/<someone>/…/server.js, so
// they passed on that Mac and could not find the file on the machine the deploy
// runs on, which blocked every deploy. They also made a "clean copy" of the
// repository quietly test the original instead of itself.

test('no backend source or test names a path on someone\'s own machine', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.endsWith('.js') && full !== __filename) {
        const text = fs.readFileSync(full, 'utf8');
        // A home directory on macOS, Linux or Windows.
        if (/['"`](\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^'"`\s]+/.test(text)) {
          offenders.push(path.relative(root, full));
        }
      }
    }
  };
  visit(root);
  assert.deepEqual(offenders, []);
});
