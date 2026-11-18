'use strict';

// ---------------------------------------------------------------------------
// Control plane: what an installed app talks to. Per-client configuration and
// feature flags, activation, the update feed, state sync and session replay.
//
// The sandbox dashboard that managed these (its page, its routes for rewriting
// a client's flags and users, the build trigger and the demo seeder) was
// removed on 2026-11-18: every one of them worked without a login.
//
//   GET    /sandbox-config/:clientId
//   GET    /api/appcast/:clientId.xml
//   POST   /api/sandbox-sync/:clientId
//   POST   /api/session-replay/:clientId
//   POST   /api/activation/activate
//   DELETE /api/activate/:clientId/:fingerprint
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function registerControlPlaneRoutes(app, { get, run }) {

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

}

module.exports = {
  registerControlPlaneRoutes,
};
