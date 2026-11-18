'use strict';

// ---------------------------------------------------------------------------
// The people master over HTTP.
//
//   GET    /api/departments                       the live ones, by name
//   POST   /api/departments                       add one
//   PATCH  /api/departments/:id                   change one (absent = keep)
//   DELETE /api/departments/:id                   remove one, and its people
//
//   GET    /api/employees                         the live ones, each with its login
//   POST   /api/employees                         add one
//   PATCH  /api/employees/:id                     change one (absent = keep)
//   DELETE /api/employees/:id                     remove one
//
//   POST   /api/employees/:id/create-login        make an account and link it
//   POST   /api/employees/:id/link-login          link an existing account
//   POST   /api/employees/:id/unlink-login        unlink (the account stays)
//
// `departments` and `employees` are the first path segments, so the central CRUD
// gate maps them to the people module. The login routes add their own guards on
// top: admin or super admin, plus the specific permission.
//
// Every route asks the module's operations (./operations.js) at the kernel
// desk. The login operations ask for the same role the guards here do.
//
// NOT here: /api/payroll/*. The registry says payroll belongs to people, but its
// routes read and compute across other tables and stay in server.js for now.
// ---------------------------------------------------------------------------

const { httpKit } = require('../../kernel/desk-kit');

module.exports = function registerPeopleRoutes(ctx) {
  const {
    app,
    desk,
    requirePermission,
    requireRoles,
    trackCreate,
    trackUpdate,
    trackDelete,
    // The auth kernel reads where a request came from, for the audit entry.
    auth,
  } = ctx;
  const { ask, refuse } = httpKit(desk);

  app.get('/api/departments', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'people.departments.list');
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, departments: result.departments, error: null });
    } catch (error) {
      res.status(500).json({ success: false, departments: [], error: error.message });
    }
  });

  app.post('/api/departments', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'people.departments.create', { ...(req.body || {}) });
      if (!result.ok) return refuse(res, result);
      trackCreate('departments', result.id, result.row, req);
      res.status(201).json({ success: true, department: result.department, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'people.departments.update', { ...(req.body || {}), id });
      if (!result.ok) return refuse(res, result);
      trackUpdate('departments', id, result.before, result.after, req);
      res.json({ success: true, department: result.department, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'people.departments.delete', { id });
      if (!result.ok) return refuse(res, result);
      // The cascade is part of what happened, so it is part of the record: a
      // sitting that showed the department going and not the people would read
      // as complete while being partial.
      for (const employee of result.employees) {
        trackDelete('employees', employee.id, employee, req);
      }
      trackDelete('departments', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/employees', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'people.employees.list');
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, employees: result.employees, error: null });
    } catch (error) {
      res.status(500).json({ success: false, employees: [], error: error.message });
    }
  });

  app.post('/api/employees', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'people.employees.create', { ...(req.body || {}) });
      if (!result.ok) return refuse(res, result);
      trackCreate('employees', result.id, result.row, req);
      res.status(201).json({ success: true, employee: result.employee, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'people.employees.update', { ...(req.body || {}), id });
      if (!result.ok) return refuse(res, result);
      trackUpdate('employees', id, result.before, result.after, req);
      res.json({ success: true, employee: result.employee, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'people.employees.delete', { id });
      if (!result.ok) return refuse(res, result);
      trackDelete('employees', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---- Unified People: connect an in-house employee to a login/profile -------

  const answerEmployee = (res, result, status = 200) => {
    if (!result.ok) {
      return res.status(result.status || 400).json({ success: false, error: result.error });
    }
    return res.status(status).json({ success: true, employee: result.employee, error: null });
  };

  // Create a brand-new login account for an in-house employee and link it.
  app.post(
    '/api/employees/:id/create-login',
    requireRoles('super_admin', 'admin'),
    requirePermission('users.create_user'),
    async (req, res) => {
      try {
        const result = await ask(req, 'people.employees.createLogin', {
          id: Number(req.params.id),
          email: req.body?.email,
          password: req.body?.password,
          role: req.body?.role,
          ipAddress: auth.getRequestIp(req),
          userAgent: auth.getRequestUserAgent(req),
        });
        answerEmployee(res, result, 201);
      } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
      }
    },
  );

  // Link an in-house employee to an EXISTING login account.
  app.post(
    '/api/employees/:id/link-login',
    requireRoles('super_admin', 'admin'),
    requirePermission('config.write'),
    async (req, res) => {
      try {
        const result = await ask(req, 'people.employees.linkLogin', {
          id: Number(req.params.id),
          userId: req.body?.userId,
        });
        answerEmployee(res, result);
      } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
      }
    },
  );

  // Unlink an employee from its login (the login account itself is kept).
  app.post(
    '/api/employees/:id/unlink-login',
    requireRoles('super_admin', 'admin'),
    requirePermission('config.write'),
    async (req, res) => {
      try {
        const result = await ask(req, 'people.employees.unlinkLogin', { id: Number(req.params.id) });
        answerEmployee(res, result);
      } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
      }
    },
  );
};
