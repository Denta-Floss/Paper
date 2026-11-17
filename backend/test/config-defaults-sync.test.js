const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Drift guard: the sandbox config defaults are declared in three places (two
// blocks in server.js at different indentation depths, one in the Flutter
// config service). If a module flag is added to one and not the others, fresh
// deployments and the app disagree about what exists.
test('config defaults stay structurally identical across server.js and config_service.dart', () => {
  // One server-side default block is in server.js (the seed for a new
  // deployment); the other moved with the control-plane routes that serve it.
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const controlPlane = fs.readFileSync(
    path.join(__dirname, '../modules/control_plane/routes.js'),
    'utf8',
  );
  const configService = fs.readFileSync(
    path.join(__dirname, '../../packages/core_erp/lib/core/services/config_service.dart'),
    'utf8',
  );

  assert.ok(
    configService.includes('"units": {"families": true}'),
    'config_service.dart lost the units.families default',
  );
  assert.ok(
    serverJs.includes('"units": {\n      "families": true\n    }'),
    'the config default block in server.js lost units.families',
  );
  assert.ok(
    controlPlane.includes('"units": {\n          "families": true\n        }'),
    'the config default block in the control-plane routes lost units.families',
  );
});
