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
// top: admin or super admin, plus the specific permission. Handlers are the ones
// that lived in server.js, moved whole.
//
// NOT here: /api/payroll/*. The registry says payroll belongs to people, but its
// routes read and compute across other tables and stay in server.js for now.
// ---------------------------------------------------------------------------

module.exports = function registerPeopleRoutes(ctx) {
  const {
    app,
    run,
    get,
    requirePermission,
    requireRoles,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    trashAndDeleteMany,
    people,
    // The auth kernel, still defined in server.js: making an account, writing the
    // audit entry, reading the caller, and the staff login code.
    auth,
  } = ctx;

  app.get('/api/departments', requirePermission('config.read'), async (_req, res) => {
    try {
      res.json({ success: true, departments: await people.listDepartments(), error: null });
    } catch (error) {
      res.status(500).json({ success: false, departments: [], error: error.message });
    }
  });

  app.post('/api/departments', requirePermission('config.write'), async (req, res) => {
    try {
      const made = await people.createDepartment(req.body);
      if (made.refusal) {
        return res.status(made.refusal.status).json(made.refusal.body);
      }
      trackCreate('departments', made.id, made.row, req);
      res.status(201).json({ success: true, department: made.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const saved = await people.updateDepartment(id, req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      trackUpdate('departments', id, saved.existing, saved.row, req);
      res.json({ success: true, department: saved.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      // Employees are owned by their department (employees.department_id is NOT NULL),
      // so cascade-trash them before removing the department. Cross-entity references
      // (e.g. an order that names a deleted client) are intentionally left for the
      // Action Center to surface rather than cascade-deleted.
      const { before, employees } = await people.getDepartmentWithEmployees(id);
      const employeeIds = employees.map((r) => r.id);
      await trashAndDeleteMany('employees', employeeIds, req);
      await trashAndDelete('departments', id, req);
      // The cascade is part of what happened, so it is part of the record: a
      // sitting that showed the department going and not the people would read
      // as complete while being partial.
      for (const employee of employees) {
        trackDelete('employees', employee.id, employee, req);
      }
      trackDelete('departments', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/employees', requirePermission('config.read'), async (_req, res) => {
    try {
      res.json({ success: true, employees: await people.listEmployees(), error: null });
    } catch (error) {
      res.status(500).json({ success: false, employees: [], error: error.message });
    }
  });

  app.post('/api/employees', requirePermission('config.write'), async (req, res) => {
    try {
      const made = await people.createEmployee(req.body);
      if (made.refusal) {
        return res.status(made.refusal.status).json(made.refusal.body);
      }
      trackCreate('employees', made.id, made.row, req);
      res.status(201).json({ success: true, employee: made.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const saved = await people.updateEmployee(id, req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      trackUpdate('employees', id, saved.existing, saved.afterRow, req);
      res.json({ success: true, employee: saved.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await people.getEmployee(id);
      await trashAndDelete('employees', id, req);
      trackDelete('employees', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---- Unified People: connect an in-house employee to a login/profile -------

  // Create a brand-new login account for an in-house employee and link it.
  app.post(
    '/api/employees/:id/create-login',
    requireRoles('super_admin', 'admin'),
    requirePermission('users.create_user'),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const emp = await people.getEmployee(id);
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
        if ((emp.employment_type || 'in-house') !== 'in-house') {
          return res.status(400).json({ success: false, error: 'Only in-house employees can be given a login.' });
        }
        if (emp.user_id) {
          return res.status(409).json({ success: false, error: 'This employee already has a linked login.' });
        }
        const email = String(req.body?.email || emp.email || '').trim();
        if (!email) return res.status(400).json({ success: false, error: 'An email is required to create a login.' });
        const password = String(req.body?.password || '');
        // Employee logins default to the 'user' (staff) role. Elevating to 'admin'
        // requires the admin-creation permission; super_admin cannot be created here.
        let role = String(req.body?.role || 'user').trim();
        if (role === 'super_admin') {
          return res.status(403).json({ success: false, error: 'Cannot create a super admin from an employee.' });
        }
        if (role === 'admin' && req.user.role !== 'super_admin') {
          return res.status(403).json({ success: false, error: 'Only a super admin can grant admin access.' });
        }
        if (role !== 'admin') role = 'user';

        const user = await auth.createUserAccount({
          name: emp.name,
          email,
          password,
          role,
          createdByUserId: req.user.id,
        });
        await run('UPDATE employees SET user_id = ?, email = ?, updated_at = ? WHERE id = ?', [
          user.id, email, new Date().toISOString(), id,
        ]);
        // Simple staff login: use the employee's DDMM (from DOB) as their 4-digit
        // code, or the next free code if that one is already taken.
        const dobPin = auth.deriveDobPin(emp.date_of_birth);
        if (dobPin) {
          const pin = await auth.nextFreeMobilePin(dobPin, user.id);
          await run('UPDATE users SET mobile_pin = ? WHERE id = ?', [pin, user.id]);
        }
        await auth.logAuthEvent({
          eventType: 'user_created',
          actorUserId: req.user.id,
          targetUserId: user.id,
          ipAddress: auth.getRequestIp(req),
          userAgent: auth.getRequestUserAgent(req),
          metadata: { role, viaEmployee: id },
        });
        const row = await people.getEmployeeWithLogin(id);
        res.status(201).json({ success: true, employee: people.rowToEmployeeDto(row), error: null });
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
        const id = Number(req.params.id);
        const userId = Number(req.body?.userId);
        const emp = await people.getEmployee(id);
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
        if ((emp.employment_type || 'in-house') !== 'in-house') {
          return res.status(400).json({ success: false, error: 'Only in-house employees can be linked to a login.' });
        }
        if (!Number.isFinite(userId)) return res.status(400).json({ success: false, error: 'userId is required.' });
        const user = await get('SELECT id FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, error: 'Login account not found.' });
        const other = await get('SELECT id FROM employees WHERE user_id = ? AND id != ?', [userId, id]);
        if (other) return res.status(409).json({ success: false, error: 'That login is already linked to another employee.' });

        await run('UPDATE employees SET user_id = ?, updated_at = ? WHERE id = ?', [userId, new Date().toISOString(), id]);
        const row = await people.getEmployeeWithLogin(id);
        res.json({ success: true, employee: people.rowToEmployeeDto(row), error: null });
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
        const id = Number(req.params.id);
        const emp = await people.getEmployee(id);
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
        await run('UPDATE employees SET user_id = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
        const row = await people.getEmployeeWithLogin(id);
        res.json({ success: true, employee: people.rowToEmployeeDto(row), error: null });
      } catch (error) {
        res.status(error.statusCode || 500).json({ success: false, error: error.message });
      }
    },
  );
};
