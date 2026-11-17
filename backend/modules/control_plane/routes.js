'use strict';

// ---------------------------------------------------------------------------
// Control plane: what the vendor's side talks to. Per-client configuration
// and feature flags, activation, build and update feeds, session replay, and
// the sandbox dashboard that manages them.
//
//   POST   /dev/seed-manufacturing-demo
//   GET    /sandbox-config/:clientId
//   GET    /api/appcast/:clientId.xml
//   GET    /api/sandbox-dashboard/feature-registry
//   POST   /api/sandbox-sync/:clientId
//   POST   /api/session-replay/:clientId
//   GET    /api/sandbox-dashboard/clients
//   GET    /api/sandbox-dashboard/client/:clientId
//   POST   /api/sandbox-dashboard/client/:clientId/config
//   POST   /api/activation/activate
//   POST   /api/sandbox-dashboard/client/:clientId/users
//   DELETE /api/sandbox-dashboard/client/:clientId/user/:email
//   DELETE /api/activate/:clientId/:fingerprint
//   POST   /api/build/global
//   GET    /api/sandbox-dashboard/client/:clientId/replays
//   GET    /api/sandbox-dashboard/replay/:id
//   GET    /dashboard
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// `serverDir` is the backend's own directory (where server.js is): files these
// handlers read or write are found from there, not from this module's folder.
function registerControlPlaneRoutes(app, {
  all,
  createRunFromTemplate,
  get,
  run,
  serverDir,
}) {
  app.post('/dev/seed-manufacturing-demo', async (req, res) => {
    try {
      const demoBarcode = `DEMO-MAT-${Date.now()}`;
      const demoMachine = `MCH-DEMO-${Date.now()}`;
      const demoDie = `DIE-DEMO-${Date.now()}`;
    
      await run(`
        INSERT INTO machines (
          asset_id, name, primary_photo_url, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
      `, [demoMachine, 'Demo Power Press', '/public/power_press.png']);

      await run(`
        INSERT INTO dies (
          tool_code, produced_part_numbers, photo_urls, compatible_machine_group_ids, status, ownership, created_at, updated_at
        ) VALUES (?, '[]', ?, '[]', 'active', 'owned', datetime('now'), datetime('now'))
      `, [demoDie, JSON.stringify(['/public/demo_die.png'])]);
    
      await run(`
        INSERT INTO materials (
          barcode, type, name, unit, kind, created_at, updated_at
        ) VALUES (?, 'raw_material', 'Demo PVC Resin', 'kg', 'single', datetime('now'), datetime('now'))
      `, [demoBarcode]);
    
      const templateId = `tpl-demo-${Date.now()}`;
      const nodes = [
        { id: 'node-1', type: 'operation', machineId: demoMachine, dieId: demoDie }
      ];
      await run(`
        INSERT INTO pipeline_templates (
          id, name, version, status, stage_labels_json, lane_labels_json, nodes_json, flows_json
        ) VALUES (?, 'Demo Power Press Pipeline', 1, 'published', '["Pressing", "Inspection"]', '[]', ?, '[]')
      `, [templateId, JSON.stringify(nodes)]);
    
      const pipelineRun = await createRunFromTemplate(templateId, 'Demo Production Run', null, null, 'inventory');
    
      await run(`
        INSERT INTO run_barcode_inputs (
          id, run_id, node_id, barcode, material_payload_json, scanned_at
        ) VALUES (?, ?, 'node-1', ?, '{}', datetime('now'))
      `, [`input-${Date.now()}`, pipelineRun.id, demoBarcode]);
    
      res.json({ success: true, barcode: demoBarcode });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Public configuration fetch endpoint (polled by clients at startup/update check)
  app.get('/sandbox-config/:clientId', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const row = await get('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', [clientId]);
      if (row) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(row.config_json);
      }
      // Fall back to default config if client specific config doesn't exist
      const defaultRow = await get('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', ['default']);
      if (defaultRow) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(defaultRow.config_json);
      }
      // Static fallback
      res.json({
        "modules": {
          "orders": true,
          "masters": true,
          "inventory": true,
          "production": true,
          "pm": true,
          "jobs": true,
          "delivery_challans": true,
          "actionCenter": true
        },
        "orders": {
          "statusColors": {
            "pending": "#FFA500",
            "in_progress": "#1E90FF",
            "completed": "#32CD32"
          },
          "allowCustomActions": true,
          "allowOrdersCreation": true,
          "showReport": true
        },
        "features": {
          "disableMachineCustomFields": false
        },
        "production": {
          "multiScrapItems": true,
          "materialVariationPaths": true
        },
        "enhancements": {
          "catalogInventory": true,
          "boardingPassCards": true
        },
        "challans": {
          "singleTypeView": true,
          "reconciliation": true
        },
        "catalog": {
          "purchaseItems": true
        },
        "purchase": {
          "flowV2": true
        },
        "update": {
          "channel": "stable",
          "latest_version": "1.0.0"
        },
        "masters": {
          "linkColumns": true
        },
        "routes": {
          "listLens": false
        },
        "units": {
          "families": true
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Dynamic Appcast XML endpoint for the auto-updater
  app.get('/api/appcast/:clientId.xml', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      let configStr = null;
      const row = await get('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', [clientId]);
      if (row) {
        configStr = row.config_json;
      } else {
        const defaultRow = await get('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', ['default']);
        if (defaultRow) configStr = defaultRow.config_json;
      }
    
      let targetVersion = '1.0.0';
      if (configStr) {
        try {
          const config = JSON.parse(configStr);
          if (config.update && config.update.latest_version) {
            targetVersion = config.update.latest_version;
          }
        } catch (e) {}
      }

      // Replace this with your actual S3 bucket public URL or CloudFront distribution
      const bucketUrl = process.env.AWS_S3_UPDATE_BUCKET_URL || 'https://your-bucket.s3.amazonaws.com/releases';
      const downloadUrl = `${bucketUrl}/${targetVersion}/paper-windows-v${targetVersion}.exe`;

      const xml = `<?xml version="1.0" encoding="utf-8"?>
  <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
      <channel>
          <title>Paper Appcast</title>
          <item>
              <title>Version ${targetVersion}</title>
              <sparkle:version>${targetVersion}</sparkle:version>
              <enclosure url="${downloadUrl}" sparkle:os="windows" />
          </item>
      </channel>
  </rss>`;

      res.setHeader('Content-Type', 'application/xml');
      res.send(xml);
    } catch (error) {
      res.status(500).send('<error>Internal Server Error</error>');
    }
  });

  // Serve the centralized feature registry definition
  app.get('/api/sandbox-dashboard/feature-registry', (req, res) => {
    try {
      const registryPath = path.join(serverDir, 'feature_registry.json');
      if (fs.existsSync(registryPath)) {
        const data = fs.readFileSync(registryPath, 'utf8');
        res.setHeader('Content-Type', 'application/json');
        return res.send(data);
      }
      return res.json([]);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Client SQLite database sync endpoint
  app.post('/api/sandbox-sync/:clientId', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ success: false, error: 'Missing sync data' });
      }
    
      const zlib = require('zlib');
      const buffer = Buffer.from(data, 'base64');
      zlib.gunzip(buffer, async (err, decoded) => {
        if (err) {
          console.error('[Sandbox Sync Error] Gunzip failed:', err);
          return res.status(400).json({ success: false, error: 'Decompression failed' });
        }
        try {
          const dbStateStr = decoded.toString('utf8');
          // Validate JSON
          JSON.parse(dbStateStr);
        
          await run(`
            INSERT INTO sandbox_sync_states (client_id, db_state, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(client_id) DO UPDATE SET
              db_state = excluded.db_state,
              updated_at = excluded.updated_at
          `, [clientId, dbStateStr]);
        
          res.json({ success: true, message: 'Sync successful' });
        } catch (e) {
          console.error('[Sandbox Sync Error] JSON parse or SQL save failed:', e);
          res.status(400).json({ success: false, error: 'Invalid sync payload structure' });
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Client session replay sync endpoint
  app.post('/api/session-replay/:clientId', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const { data } = req.body;
      if (!data) return res.status(400).json({ success: false, error: 'Missing replay data' });
    
      const zlib = require('zlib');
      const buffer = Buffer.from(data, 'base64');
      zlib.gunzip(buffer, async (err, decoded) => {
        if (err) {
          console.error('[Replay Sync Error] Gunzip failed:', err);
          return res.status(400).json({ success: false, error: 'Decompression failed' });
        }
        try {
          const payload = JSON.parse(decoded.toString('utf8'));
          const { sessionId, events } = payload;
        
          // Fetch existing replay for this session
          const existing = await get('SELECT events_json FROM sandbox_replays WHERE client_id = ? AND session_id = ?', [clientId, sessionId]);
          let allEvents = [];
          if (existing) {
            allEvents = JSON.parse(existing.events_json);
          }
          allEvents.push(...events);
        
          if (existing) {
            await run('UPDATE sandbox_replays SET events_json = ? WHERE client_id = ? AND session_id = ?', [JSON.stringify(allEvents), clientId, sessionId]);
          } else {
            await run('INSERT INTO sandbox_replays (client_id, session_id, events_json, created_at) VALUES (?, ?, ?, datetime(\'now\'))', [clientId, sessionId, JSON.stringify(allEvents)]);
          }
        
          res.json({ success: true, message: 'Replay synced successfully' });
        } catch (e) {
          console.error('[Replay Sync Error] JSON parse or SQL save failed:', e);
          res.status(400).json({ success: false, error: 'Invalid payload structure' });
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Dashboard APIs (for config and observation)
  app.get('/api/sandbox-dashboard/clients', async (req, res) => {
    try {
      const configs = await all('SELECT client_id, updated_at FROM sandbox_client_configs');
      const syncs = await all('SELECT client_id, updated_at FROM sandbox_sync_states');
    
      const clientsMap = {};
      for (const c of configs) {
        clientsMap[c.client_id] = { clientId: c.client_id, configUpdatedAt: c.updated_at, syncUpdatedAt: null };
      }
      for (const s of syncs) {
        if (!clientsMap[s.client_id]) {
          clientsMap[s.client_id] = { clientId: s.client_id, configUpdatedAt: null };
        }
        clientsMap[s.client_id].syncUpdatedAt = s.updated_at;
      }
      res.json({ success: true, clients: Object.values(clientsMap) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sandbox-dashboard/client/:clientId', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const configRow = await get('SELECT config_json FROM sandbox_client_configs WHERE client_id = ?', [clientId]);
      const syncRow = await get('SELECT db_state, updated_at FROM sandbox_sync_states WHERE client_id = ?', [clientId]);
      const pinRow = await get('SELECT activation_pin FROM sandbox_client_pins WHERE client_id = ?', [clientId]);
      const machines = await all('SELECT * FROM sandbox_activated_machines WHERE client_id = ?', [clientId]);
      const users = await all('SELECT * FROM sandbox_client_users WHERE client_id = ?', [clientId]);
    
      res.json({
        success: true,
        clientId,
        activationPin: pinRow ? pinRow.activation_pin : null,
        activatedMachines: machines || [],
        users: users || [],
        config: configRow ? JSON.parse(configRow.config_json) : null,
        syncState: syncRow ? JSON.parse(syncRow.db_state) : null,
        syncUpdatedAt: syncRow ? syncRow.updated_at : null
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/sandbox-dashboard/client/:clientId/config', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const { config } = req.body;
      if (!config) {
        return res.status(400).json({ success: false, error: 'Missing configuration' });
      }
    
      await run(`
        INSERT INTO sandbox_client_configs (client_id, config_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(client_id) DO UPDATE SET
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `, [clientId, JSON.stringify(config)]);
    
      // Generate an activation pin if it doesn't exist
      const pinRow = await get('SELECT activation_pin FROM sandbox_client_pins WHERE client_id = ?', [clientId]);
      if (!pinRow) {
        const newPin = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit pin
        await run('INSERT INTO sandbox_client_pins (client_id, activation_pin, created_at) VALUES (?, ?, datetime("now"))', [clientId, newPin]);
      }
    
      res.json({ success: true, message: 'Configuration saved' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/activation/activate', async (req, res) => {
    try {
      const { client_id, activation_pin, fingerprint } = req.body;
      if (!client_id || !activation_pin || !fingerprint) {
        return res.status(400).json({ success: false, error: 'Missing required activation parameters' });
      }

      // Verify pin
      const pinRow = await get('SELECT activation_pin FROM sandbox_client_pins WHERE client_id = ?', [client_id]);
      if (!pinRow || pinRow.activation_pin !== activation_pin) {
        return res.status(401).json({ success: false, error: 'Invalid client ID or activation PIN' });
      }

      // Verify machine limit (max 3)
      const machineCountRow = await get('SELECT COUNT(*) as count FROM sandbox_activated_machines WHERE client_id = ?', [client_id]);
      if (machineCountRow && machineCountRow.count >= 3) {
        // Check if this fingerprint is already one of the 3
        const existing = await get('SELECT token FROM sandbox_activated_machines WHERE client_id = ? AND machine_fingerprint = ?', [client_id, fingerprint]);
        if (!existing) {
          return res.status(403).json({ success: false, error: 'Activation limit reached (Max 3 machines).' });
        }
      }

      // Generate token (crypto random for sandbox)
      const token = crypto.randomBytes(32).toString('hex');
    
      await run(`
        INSERT INTO sandbox_activated_machines (client_id, machine_fingerprint, token, activated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(client_id, machine_fingerprint) DO UPDATE SET token = excluded.token, activated_at = excluded.activated_at
      `, [client_id, fingerprint, token]);

      // Check if this is the first activation (to guide user creation on the frontend)
      const isFirstActivation = machineCountRow.count === 0;

      res.json({ success: true, token, isFirstActivation });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/sandbox-dashboard/client/:clientId/users', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const { email, role } = req.body;
      if (!email || !role) return res.status(400).json({ success: false, error: 'Missing user details' });

      await run(`
        INSERT INTO sandbox_client_users (client_id, user_email, role, created_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(client_id, user_email) DO UPDATE SET role = excluded.role
      `, [clientId, email, role]);

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/sandbox-dashboard/client/:clientId/user/:email', async (req, res) => {
    try {
      const { clientId, email } = req.params;
      await run('DELETE FROM sandbox_client_users WHERE client_id = ? AND user_email = ?', [clientId, email]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/activate/:clientId/:fingerprint', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const fingerprint = req.params.fingerprint;
      await run('DELETE FROM sandbox_activated_machines WHERE client_id = ? AND machine_fingerprint = ?', [clientId, fingerprint]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/build/global', async (req, res) => {
    try {
      // Empty version = fresh build (artifact only). The workflow gates its S3
      // publish step on a non-empty target_version, so don't default it here.
      const targetVersion = (req.body.targetVersion || '').trim();
      const githubToken = process.env.GITHUB_TOKEN;
      const githubOwner = process.env.GITHUB_OWNER || 'your-github-username';
      const githubRepo = process.env.GITHUB_REPO || 'core-erp';

      if (!githubToken) {
        return res.status(500).json({ success: false, error: 'GITHUB_TOKEN is not set in environment variables.' });
      }

      const url = `https://api.github.com/repos/${githubOwner}/${githubRepo}/actions/workflows/build-desktop.yml/dispatches`;
    
      // Using global fetch (Node 18+)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            target_version: targetVersion
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ success: false, error: `GitHub API error: ${errorText}` });
      }

      res.json({
        success: true,
        message: targetVersion
          ? `Global Build v${targetVersion} dispatched successfully!`
          : 'Fresh build dispatched (no version, not published).',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sandbox-dashboard/client/:clientId/replays', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const rows = await all('SELECT id, session_id, created_at, length(events_json) as size FROM sandbox_replays WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
      res.json({ success: true, replays: rows });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/sandbox-dashboard/replay/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const row = await get('SELECT session_id, events_json, created_at FROM sandbox_replays WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ success: false, error: 'Replay not found' });
      res.json({
        success: true,
        sessionId: row.session_id,
        events: JSON.parse(row.events_json),
        createdAt: row.created_at
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Serve the beautiful Dashboard UI
  app.get('/dashboard', (req, res) => {
    const dashboardPath = path.join(serverDir, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
      res.sendFile(dashboardPath);
    } else {
      res.status(404).send('Dashboard UI file not found');
    }
  });
}

module.exports = {
  registerControlPlaneRoutes,
};
