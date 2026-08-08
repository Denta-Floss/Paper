'use strict';

// ---------------------------------------------------------------------------
// Freelancer Portal module — HTTP routes.
//
// Route registration for freelancer-portal moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order matches
// server.js exactly.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

module.exports = function registerFreelancerPortalModuleRoutes(ctx) {
  const {
    app,
    get,
    all,
  } = ctx;

app.get('/api/freelancer-portal/data', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ success: false, error: 'Missing token' });
    
    const SECRET = 'my-very-secret-key-32charslong!!'; 
    let barcode_id;
    try {
      const parts = token.split(':');
      const iv = Buffer.from(parts[0], 'hex');
      const encryptedText = Buffer.from(parts[1], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SECRET), iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      barcode_id = decrypted.toString();
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid or tampered token' });
    }

    const employee = ctx.getFreelancerEmployee
      ? await ctx.getFreelancerEmployee(barcode_id)
      : null;
    if (!employee) return res.status(404).json({ success: false, error: 'Freelancer not found' });

    if (ctx.getFreelancerPortalData) {
      const data = await ctx.getFreelancerPortalData(employee.id);
      return res.json({ success: true, ...data });
    }
    
    res.json({ success: true, batches: [], jobs: [], tasks: [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
