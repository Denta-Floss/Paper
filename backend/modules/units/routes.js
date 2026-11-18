'use strict';

// Units over HTTP: the families with their ladders, and seeding the standard
// ones. Both ask the module's operations at the kernel desk (./operations.js).

function registerUnitRoutes(app, { desk, requirePermission, trackCreate }) {
  const ask = (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) });

  // Lists unit families and their ladders
  app.get('/api/units/families', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'units.families.withUnits');
      if (!result.ok) {
        res.status(result.status || 400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, families: result.families, error: null });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Seeds standard canonical families and ladders
  app.post(
    '/api/units/seed-standard',
    requirePermission('units.create'),
    async (req, res) => {
      try {
        const result = await ask(req, 'units.seedStandard');
        if (!result.ok) {
          res.status(result.status || 400).json({ success: false, error: result.error });
          return;
        }
        // trackCreate is fire-and-forget and returns nothing. This used to be
        // `await trackCreate(…).catch(…)`, which threw on the undefined and
        // answered 500 after the seed had succeeded.
        if (typeof trackCreate === 'function') {
          trackCreate('units', 'standard-seed', { seededFamilies: result.seededFamilies }, req);
        }
        res.json({ success: true, message: 'Standard units seeded successfully.' });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    },
  );
}

module.exports = {
  registerUnitRoutes,
};
