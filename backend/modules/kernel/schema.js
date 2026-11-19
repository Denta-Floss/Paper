'use strict';

// ---------------------------------------------------------------------------
// The kernel module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   asset_upload_sessions
//   auth_events
//   auth_sessions
//   changelog
//   company_profiles
//   entity_activity_log
//   global_audit_logs
//   permission_template_permissions
//   permission_templates
//   role_permissions
//   search_clicks
//   search_history
//   uploaded_assets
//   user_favorite_items
//   user_permission_overrides
//   user_permission_templates
//   user_preferences
//   user_record_permissions
//   users
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all, get }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS global_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      actor_user_id INTEGER REFERENCES users(id),
      actor_name TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details_json TEXT DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_global_audit_created ON global_audit_logs(created_at DESC)');

  await run(`
    CREATE TABLE IF NOT EXISTS changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      first_failed_login_at TEXT,
      lockout_until TEXT,
      last_login_at TEXT,
      last_login_ip TEXT DEFAULT '',
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_reason TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT ''
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked ON auth_sessions(revoked_at)');

  await run(`
    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id),
      target_user_id INTEGER REFERENCES users(id),
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_auth_events_target ON auth_events(target_user_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(role, permission_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id INTEGER NOT NULL REFERENCES users(id),
      permission_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, permission_key)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user ON user_permission_overrides(user_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS permission_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      is_system_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS permission_template_permissions (
      template_id INTEGER NOT NULL REFERENCES permission_templates(id),
      permission_key TEXT NOT NULL,
      is_allowed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(template_id, permission_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_permission_templates (
      user_id INTEGER NOT NULL REFERENCES users(id),
      template_id INTEGER NOT NULL REFERENCES permission_templates(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, template_id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_user_permission_templates_user ON user_permission_templates(user_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS company_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      mobile TEXT DEFAULT '',
      business_description TEXT DEFAULT '',
      address TEXT DEFAULT '',
      state_code TEXT DEFAULT '',
      gstin TEXT DEFAULT '',
      logo_url TEXT DEFAULT '',
      signature_label TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_favorite_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      variation_path_label TEXT NOT NULL DEFAULT '',
      variation_path_node_ids TEXT NOT NULL DEFAULT '[]',
      custom_variation_values TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, item_id, variation_leaf_node_id)
    )
  `);

  // Per-user UI preferences (e.g. which sections the item editor shows). Kept
  // per user on purpose — this is a personal form layout, not a policy.
  await run(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pref_key TEXT NOT NULL,
      value_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, pref_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      query TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_search_history_user_id ON search_history(user_id)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS search_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      query TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_label TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS uploaded_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'uploaded',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      document_title TEXT,
      position INTEGER,
      thumb_key TEXT,
      width INTEGER,
      height INTEGER,
      deleted_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS asset_upload_sessions (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      object_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_primary INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      document_title TEXT,
      thumb_key TEXT,
      width INTEGER,
      height INTEGER
    )
  `);

  // A database made before company documents has these tables without the
  // column, and CREATE TABLE IF NOT EXISTS never adds one. photo_requests comes
  // from migration 062, so it may not exist yet in a bare initDb.
  await ensureColumnExists('uploaded_assets', 'document_title', 'TEXT');

  await ensureColumnExists('asset_upload_sessions', 'document_title', 'TEXT');

  await run(
    'CREATE INDEX IF NOT EXISTS idx_asset_upload_sessions_entity ON asset_upload_sessions(entity_type, entity_id)',
  );

  // Track: generic per-entity activity log powering the "Track" tab on masters
  // and a person's People profile. Written by trackCreate/Update/Delete.
  await run(`
    CREATE TABLE IF NOT EXISTS entity_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_name TEXT,
      actor_role TEXT,
      changes_json TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      -- Which opening of a window this change belongs to; see
      -- migrations/050-activity-sitting.sql. Kept in step with that file by
      -- hand: this table is defined in both places, and a column added to one
      -- only is how a fresh database quietly loses it.
      sitting_id TEXT
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_entity_activity_log_entity ON entity_activity_log(entity_type, entity_id, created_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_entity_activity_log_actor ON entity_activity_log(actor_user_id, created_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_entity_activity_log_sitting ON entity_activity_log(sitting_id, created_at)');

  // Per-record (row-level) permission grants for an individual user.
  await run(`
    CREATE TABLE IF NOT EXISTS user_record_permissions (
      user_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, entity_type, entity_id, op)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_user_record_permissions_user ON user_record_permissions(user_id)');

  await ensureColumnExists('users', 'failed_login_attempts', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('users', 'first_failed_login_at', 'TEXT');

  await ensureColumnExists('users', 'lockout_until', 'TEXT');

  await ensureColumnExists('users', 'last_login_at', 'TEXT');

  await ensureColumnExists('users', 'last_login_ip', "TEXT DEFAULT ''");

  await ensureColumnExists('users', 'mobile_pin', "TEXT");

  await ensureColumnExists('users', 'client_id', "INTEGER REFERENCES clients(id)");

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile_pin ON users(mobile_pin)');

  await ensureColumnExists('auth_sessions', 'ip_address', "TEXT DEFAULT ''");

  await ensureColumnExists('auth_sessions', 'user_agent', "TEXT DEFAULT ''");

  await ensureColumnExists('auth_sessions', 'revoked_reason', "TEXT DEFAULT ''");

  // --- Tables whose shape an older file may need rebuilt (moved 2026-11-19,
  // B37). Their rebuild, CREATE, columns and indexes run here in the order
  // they stood in initDb; triggers, data backfills and seeds stay there.
  try { await run("ALTER TABLE auth_sessions ADD COLUMN client_platform TEXT DEFAULT 'desktop'"); } catch (e) {}
  await run('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)');

  // A part's photos in their order, each with a small copy for lists, and
  // when it was removed (the sweep deletes the objects a day later).
  for (const [column, type] of [
    ['position', 'INTEGER'],
    ['thumb_key', 'TEXT'],
    ['width', 'INTEGER'],
    ['height', 'INTEGER'],
    ['deleted_at', 'TEXT'],
  ]) {
    await ensureColumnExists('uploaded_assets', column, type);
    if (column !== 'position' && column !== 'deleted_at') {
      await ensureColumnExists('asset_upload_sessions', column, type);
    }
  }
  if ((await all('PRAGMA table_info(photo_requests)')).length) {
    await ensureColumnExists('photo_requests', 'document_title', 'TEXT');
  }

  await run(
    'CREATE INDEX IF NOT EXISTS idx_uploaded_assets_entity ON uploaded_assets(entity_type, entity_id, status, is_primary)',
  );
}

module.exports = { createSchema };
