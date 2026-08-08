'use strict';

// ---------------------------------------------------------------------------
// People module — HTTP routes.
//
// All 11 route registrations for people territory (employees & departments)
// moved VERBATIM from server.js. No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerPeopleModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    requireRoles,
    get,
    all,
    run,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    trashAndDeleteMany,
    rowToDepartmentDto,
    rowToEmployeeDto,
    getEmployeeWithLogin,
    deriveDobPin,
    nextFreeMobilePin,
    createUserAccount,
    logAuthEvent,
    getRequestIp,
    getRequestUserAgent,
  } = ctx;

app.get('/api/departments', requirePermission('config.read'), async (_req, res) => {
  try {
    const rows = await all('SELECT * FROM departments WHERE is_archived = 0 ORDER BY name ASC');
    res.json({ success: true, departments: rows.map(rowToDepartmentDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, departments: [], error: error.message });
  }
});

app.post('/api/departments', requirePermission('config.write'), async (req, res) => {
  try {
    const { name, description = '', photoUrl = '' } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    const now = new Date().toISOString();
    const result = await run(
      'INSERT INTO departments (name, description, photo_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description.trim(), photoUrl, now, now]
    );
    const row = await get('SELECT * FROM departments WHERE id = ?', [result.lastID]);
    res.status(201).json({ success: true, department: rowToDepartmentDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, description, photoUrl } = req.body;
    const existing = await get('SELECT * FROM departments WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Department not found' });
    }
    const newName = name !== undefined ? name.trim() : existing.name;
    const newDesc = description !== undefined ? description.trim() : existing.description;
    const newPhoto = photoUrl !== undefined ? photoUrl : existing.photo_url;
    
    await run(
      'UPDATE departments SET name = ?, description = ?, photo_url = ?, updated_at = ? WHERE id = ?',
      [newName, newDesc, newPhoto, new Date().toISOString(), id]
    );
    const row = await get('SELECT * FROM departments WHERE id = ?', [id]);
    res.json({ success: true, department: rowToDepartmentDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/departments/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const employeeIds = (await all('SELECT id FROM employees WHERE department_id = ?', [id])).map((r) => r.id);
    await trashAndDeleteMany('employees', employeeIds, req);
    await trashAndDelete('departments', id, req);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/employees', requirePermission('config.read'), async (_req, res) => {
  try {
    const rows = await all(
      `SELECT e.*,
              u.email AS login_email,
              u.role AS login_role,
              u.is_active AS login_is_active,
              u.mobile_pin AS login_mobile_pin
         FROM employees e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.is_archived = 0
        ORDER BY e.name ASC`,
    );
    res.json({ success: true, employees: rows.map(rowToEmployeeDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, employees: [], error: error.message });
  }
});

app.post('/api/employees', requirePermission('config.write'), async (req, res) => {
  try {
    const { departmentId, name, role = '', phone = '', aadharNumber = '', aadharPhotoUrl = '', panNumber = '', panPhotoUrl = '', address = '', employeePhotoUrl = '', employmentType = 'in-house', status = 'active', barcodeId = '', email = '', dateOfBirth = '' } = req.body;
    if (!name || !departmentId) {
      return res.status(400).json({ success: false, error: 'Name and departmentId are required' });
    }
    const now = new Date().toISOString();
    const result = await run(
      'INSERT INTO employees (department_id, name, role, phone, aadhar_number, aadhar_photo_url, pan_number, pan_photo_url, address, employee_photo_url, employment_type, status, barcode_id, email, date_of_birth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [departmentId, name.trim(), role.trim(), phone.trim(), aadharNumber.trim(), aadharPhotoUrl, panNumber.trim(), panPhotoUrl, address.trim(), employeePhotoUrl, employmentType, status, barcodeId.trim(), String(email || '').trim(), String(dateOfBirth || '').trim(), now, now]
    );
    const row = await getEmployeeWithLogin(result.lastID);
    trackCreate('employees', result.lastID, row, req);
    res.status(201).json({ success: true, employee: rowToEmployeeDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, role, phone, aadharNumber, aadharPhotoUrl, panNumber, panPhotoUrl, address, employeePhotoUrl, employmentType, status, departmentId, barcodeId, email, dateOfBirth } = req.body;
    const existing = await get('SELECT * FROM employees WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Employee not found' });
    }
    const newEmail = email !== undefined ? String(email || '').trim() : (existing.email || '');
    const newDob = dateOfBirth !== undefined ? String(dateOfBirth || '').trim() : (existing.date_of_birth || '');
    const newName = name !== undefined ? name.trim() : existing.name;
    const newRole = role !== undefined ? role.trim() : existing.role;
    const newPhone = phone !== undefined ? phone.trim() : existing.phone;
    const newAadhar = aadharNumber !== undefined ? aadharNumber.trim() : existing.aadhar_number;
    const newAadharPhoto = aadharPhotoUrl !== undefined ? aadharPhotoUrl : existing.aadhar_photo_url;
    const newPan = panNumber !== undefined ? panNumber.trim() : existing.pan_number;
    const newPanPhoto = panPhotoUrl !== undefined ? panPhotoUrl : existing.pan_photo_url;
    const newAddress = address !== undefined ? address.trim() : existing.address;
    const newEmployeePhoto = employeePhotoUrl !== undefined ? employeePhotoUrl : existing.employee_photo_url;
    const newEmpType = employmentType !== undefined ? employmentType : existing.employment_type;
    const newStatus = status !== undefined ? status : existing.status;
    const newDep = departmentId !== undefined ? departmentId : existing.department_id;
    const newBarcodeId = barcodeId !== undefined ? barcodeId.trim() : existing.barcode_id;

    await run(
      'UPDATE employees SET name = ?, role = ?, phone = ?, aadhar_number = ?, aadhar_photo_url = ?, pan_number = ?, pan_photo_url = ?, address = ?, employee_photo_url = ?, employment_type = ?, status = ?, department_id = ?, barcode_id = ?, email = ?, date_of_birth = ?, updated_at = ? WHERE id = ?',
      [newName, newRole, newPhone, newAadhar, newAadharPhoto, newPan, newPanPhoto, newAddress, newEmployeePhoto, newEmpType, newStatus, newDep, newBarcodeId, newEmail, newDob, new Date().toISOString(), id]
    );
    if (existing.user_id && newDob !== (existing.date_of_birth || '')) {
      const dobPin = deriveDobPin(newDob);
      if (dobPin) {
        const pin = await nextFreeMobilePin(dobPin, existing.user_id);
        await run('UPDATE users SET mobile_pin = ?, updated_at = ? WHERE id = ?', [pin, new Date().toISOString(), existing.user_id]);
      }
    }
    const afterRow = await get('SELECT * FROM employees WHERE id = ?', [id]);
    trackUpdate('employees', id, existing, afterRow, req);
    const row = await getEmployeeWithLogin(id);
    res.json({ success: true, employee: rowToEmployeeDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/employees/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = await get('SELECT * FROM employees WHERE id = ?', [id]);
    await trashAndDelete('employees', id, req);
    trackDelete('employees', id, before, req);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post(
  '/api/employees/:id/create-login',
  requireRoles('super_admin', 'admin'),
  requirePermission('users.create_user'),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const emp = await get('SELECT * FROM employees WHERE id = ?', [id]);
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
      let role = String(req.body?.role || 'user').trim();
      if (role === 'super_admin') {
        return res.status(403).json({ success: false, error: 'Cannot create a super admin from an employee.' });
      }
      if (role === 'admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ success: false, error: 'Only a super admin can grant admin access.' });
      }
      if (role !== 'admin') role = 'user';

      const user = await createUserAccount({
        name: emp.name,
        email,
        password,
        role,
        createdByUserId: req.user.id,
      });
      await run('UPDATE employees SET user_id = ?, email = ?, updated_at = ? WHERE id = ?', [
        user.id, email, new Date().toISOString(), id,
      ]);
      const dobPin = deriveDobPin(emp.date_of_birth);
      if (dobPin) {
        const pin = await nextFreeMobilePin(dobPin, user.id);
        await run('UPDATE users SET mobile_pin = ? WHERE id = ?', [pin, user.id]);
      }
      await logAuthEvent({
        eventType: 'user_created',
        actorUserId: req.user.id,
        targetUserId: user.id,
        ipAddress: getRequestIp(req),
        userAgent: getRequestUserAgent(req),
        metadata: { role, viaEmployee: id },
      });
      const row = await getEmployeeWithLogin(id);
      res.status(201).json({ success: true, employee: rowToEmployeeDto(row), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  '/api/employees/:id/link-login',
  requireRoles('super_admin', 'admin'),
  requirePermission('config.write'),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const userId = Number(req.body?.userId);
      const emp = await get('SELECT * FROM employees WHERE id = ?', [id]);
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
      const row = await getEmployeeWithLogin(id);
      res.json({ success: true, employee: rowToEmployeeDto(row), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  },
);

app.post(
  '/api/employees/:id/unlink-login',
  requireRoles('super_admin', 'admin'),
  requirePermission('config.write'),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const emp = await get('SELECT * FROM employees WHERE id = ?', [id]);
      if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
      await run('UPDATE employees SET user_id = NULL, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
      const row = await getEmployeeWithLogin(id);
      res.json({ success: true, employee: rowToEmployeeDto(row), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  },
);

};
