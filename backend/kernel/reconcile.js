'use strict';

// ---------------------------------------------------------------------------
// Reconciler v0 — DRIFT REPORT (read-only; no convergence yet).
//
// Infrastructure-as-code starts with an honest answer to one question: does
// reality match what we declared? This module compares four declarations
// against four actual states and reports every disagreement:
//
//   declared                         actual
//   --------                         ------
//   kernel/registry.js manifests  ->  routes mounted on the Express app
//   manifest `tables`             ->  tables present in sqlite_master
//   manifest `evacuated`          ->  modules/<key>/ package on disk
//   migrations/*.sql on disk      ->  _migrations rows applied in this DB
//   sandbox_client_configs        ->  registry module keys (naming drift)
//
// v1 will add plan/apply (converge desired -> actual). v0 deliberately only
// reports: you cannot safely converge a system whose drift you cannot see.
//
// Every finding is one `drift` entry: {kind, severity, subject, declared,
// actual, detail}. An empty drift array means reality matches declaration.
// ---------------------------------------------------------------------------

const registry = require('./registry');
const territory = require('./territory');

// Legacy config flag keys (sandbox_client_configs.modules.*) mapped to the
// kernel module keys they gate. The config predates the registry, so its
// vocabulary is coarser: one "masters" switch covers eight master modules.
// This map IS the translation layer; anything unmapped is reported as drift.
const CONFIG_MODULE_ALIASES = {
  orders: ['orders'],
  inventory: ['inventory'],
  production: ['production', 'pipelines'],
  jobs: ['jobs'],
  delivery_challans: ['challans'],
  actionCenter: ['action_center'],
  masters: ['people', 'clients', 'vendors', 'items', 'units', 'machines', 'dies'],
  // `pm` (preventative maintenance) has no kernel module yet — reported as
  // drift rather than silently ignored.
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function drift(kind, severity, subject, declared, actual, detail) {
  return { kind, severity, subject, declared, actual, detail };
}

async function reconcile({
  app,
  allRows,
  getRow,
  migrationFiles = [],
  moduleDirs = [],
  clientId = 'default',
}) {
  const findings = [];

  // --- 1. Territory: routes + tables claimed vs present -------------------
  const territoryReport = await territory.computeTerritory({ app, allRows });

  for (const [moduleKey, info] of Object.entries(territoryReport.modules)) {
    const declaredTables = info.declaredTables || [];
    const presentTables = info.tablesPresent || [];
    const missingTables = declaredTables.filter((t) => !presentTables.includes(t));
    if (missingTables.length) {
      findings.push(
        drift(
          'table-missing',
          'error',
          `module:${moduleKey}`,
          declaredTables.length,
          presentTables.length,
          `Manifest declares tables that do not exist in this database: ${missingTables.join(', ')}. Either the migration has not run here or the manifest claims territory it does not own.`,
        ),
      );
    }
    if (info.routes === 0 && (registry.MODULES[moduleKey].pathSegments || []).length > 0) {
      findings.push(
        drift(
          'routes-unmounted',
          'error',
          `module:${moduleKey}`,
          (registry.MODULES[moduleKey].pathSegments || []).join(', '),
          '0 routes',
          'Manifest declares path segments but no routes answering them are mounted. The module is declared but not reachable.',
        ),
      );
    }
  }

  const unclaimedSegments = Object.entries(territoryReport.unclaimed.routeSegments || {});
  if (unclaimedSegments.length) {
    findings.push(
      drift(
        'territory-unclaimed-routes',
        'warning',
        'kernel',
        'every /api route claimed by a module or the kernel',
        `${territoryReport.summary.routes.unclaimed} routes across ${unclaimedSegments.length} segments`,
        `Unclaimed route segments bypass central module-permission enforcement: ${unclaimedSegments
          .map(([seg, count]) => `${seg} (${count})`)
          .join(', ')}.`,
      ),
    );
  }
  if ((territoryReport.unclaimed.tables || []).length) {
    findings.push(
      drift(
        'territory-unclaimed-tables',
        'info',
        'kernel',
        'every table owned by a module or the kernel',
        `${territoryReport.unclaimed.tables.length} unowned`,
        `Tables no manifest claims: ${territoryReport.unclaimed.tables.join(', ')}.`,
      ),
    );
  }

  // --- 2. Evacuation: manifest flag vs package on disk --------------------
  const moduleDirSet = new Set(moduleDirs);
  for (const moduleKey of registry.CRUD_MODULES) {
    const claimsEvacuated = Boolean(registry.MODULES[moduleKey].evacuated);
    const hasPackage = moduleDirSet.has(moduleKey);
    if (claimsEvacuated && !hasPackage) {
      findings.push(
        drift(
          'evacuation-claimed-without-package',
          'error',
          `module:${moduleKey}`,
          'evacuated: true',
          'no backend/modules/<key>/ directory',
          'The manifest claims this module has left the monolith, but no module package exists on disk.',
        ),
      );
    } else if (!claimsEvacuated && hasPackage) {
      findings.push(
        drift(
          'evacuation-unflagged-package',
          'info',
          `module:${moduleKey}`,
          'evacuated: false',
          'backend/modules/<key>/ exists',
          'A module package exists but the manifest still marks it as living in legacy. Update the flag once the move is complete.',
        ),
      );
    }
  }

  // --- 3. Migrations: files on disk vs applied rows -----------------------
  let appliedMigrations = [];
  let migrationsTracked = true;
  try {
    appliedMigrations = (await allRows('SELECT name FROM _migrations ORDER BY name', [])).map(
      (row) => row.name,
    );
  } catch (_) {
    migrationsTracked = false;
  }
  if (!migrationsTracked) {
    findings.push(
      drift(
        'migrations-untracked',
        'warning',
        'database',
        `${migrationFiles.length} migration files on disk`,
        'no _migrations table',
        'This database has never run the migration runner (fresh DBs bootstrap schema directly). Bootstrap and migrations must stay in parity — see initDb ensureColumnExists parity blocks.',
      ),
    );
  } else {
    const appliedSet = new Set(appliedMigrations);
    const pending = migrationFiles.filter((f) => !appliedSet.has(f));
    const unknown = appliedMigrations.filter((name) => !migrationFiles.includes(name));
    if (pending.length) {
      findings.push(
        drift(
          'migrations-pending',
          'error',
          'database',
          `${migrationFiles.length} on disk`,
          `${appliedMigrations.length} applied`,
          `Migrations present but not applied here: ${pending.join(', ')}.`,
        ),
      );
    }
    if (unknown.length) {
      findings.push(
        drift(
          'migrations-unknown',
          'warning',
          'database',
          `${migrationFiles.length} on disk`,
          `${appliedMigrations.length} applied`,
          `Applied migrations with no file on disk (deployed from a different revision): ${unknown.join(', ')}.`,
        ),
      );
    }
  }

  // --- 4. Config flags vs registry module vocabulary ----------------------
  let config = null;
  let configSource = clientId;
  try {
    let row = await getRow('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', [
      clientId,
    ]);
    if (!row && clientId !== 'default') {
      row = await getRow('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', [
        'default',
      ]);
      configSource = 'default (fallback)';
    }
    config = row ? JSON.parse(row.config_json) : null;
  } catch (_) {
    config = null;
  }

  const moduleFlags = (config && config.modules) || {};
  const configKeys = Object.keys(moduleFlags);
  const mappedModuleKeys = new Set();
  for (const configKey of configKeys) {
    const targets = CONFIG_MODULE_ALIASES[configKey];
    if (!targets) {
      findings.push(
        drift(
          'config-flag-unmapped',
          'warning',
          `config:modules.${configKey}`,
          'a kernel module it gates',
          'no mapping',
          `The deployment config carries a module flag the kernel registry knows nothing about. It cannot gate anything, and collapsing it would be a silent no-op.`,
        ),
      );
      continue;
    }
    targets.forEach((key) => mappedModuleKeys.add(key));
    const enabled = moduleFlags[configKey] !== false;
    if (!enabled) {
      const stillMounted = targets.filter(
        (key) => (territoryReport.modules[key] || {}).routes > 0,
      );
      if (stillMounted.length) {
        findings.push(
          drift(
            'module-disabled-but-mounted',
            'error',
            `config:modules.${configKey}`,
            'disabled',
            `routes still mounted for: ${stillMounted.join(', ')}`,
            'The config collapses this module but its routes still answer. Expansion/collapse is not yet enforced by the kernel — this is the gap reconciler v1 (apply) closes.',
          ),
        );
      }
    }
  }
  const ungatedModules = registry.CRUD_MODULES.filter((key) => !mappedModuleKeys.has(key));
  if (config && ungatedModules.length) {
    findings.push(
      drift(
        'module-ungated',
        'warning',
        'kernel',
        'every module gated by a config flag',
        `${ungatedModules.length} ungated`,
        `Modules no deployment flag can turn off: ${ungatedModules.join(', ')}. They cannot be collapsed per client.`,
      ),
    );
  }

  findings.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  const counts = findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    },
    { error: 0, warning: 0, info: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    clientId: configSource,
    converged: counts.error === 0,
    summary: {
      driftCount: findings.length,
      ...counts,
      modules: {
        declared: registry.CRUD_MODULES.length,
        evacuated: registry.CRUD_MODULES.filter((k) => registry.MODULES[k].evacuated).length,
      },
      migrations: {
        onDisk: migrationFiles.length,
        applied: appliedMigrations.length,
        tracked: migrationsTracked,
      },
      routes: territoryReport.summary.routes,
      tables: territoryReport.summary.tables,
    },
    drift: findings,
    territory: territoryReport,
  };
}

module.exports = { reconcile, CONFIG_MODULE_ALIASES };
