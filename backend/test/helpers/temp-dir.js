'use strict';

// A throwaway folder for one test file's database and uploads, removed when
// the test process exits.
//
// Every test file used to make its own with mkdtempSync and never remove it:
// a full run left about 800 folders (1.2 GB) behind, and on 2026-11-18 the
// disk filled up mid-task. Removal at exit is safe with the SQLite handle
// still open: the files are unlinked and the handle goes with the process.

const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');

const made = [];
let hooked = false;

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  if (!hooked) {
    hooked = true;
    process.once('exit', () => {
      for (const d of made) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch (_) {
          // Best effort; nothing to do about it at exit.
        }
      }
    });
  }
  return dir;
}

module.exports = { makeTempDir };
