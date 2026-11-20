'use strict';

// ---------------------------------------------------------------------------
// The people master: departments, employees, and an employee's link to a login.
//
// Takes {get, all, run} plus the two auth helpers it needs to keep a staff
// member's login code in step with their birth date:
//
//   auth.deriveDobPin(dob)                          '1990-03-15' -> '1503'
//   auth.nextFreeMobilePin(preferred, excludeUserId) the code, or the next free
//
// Creating a login account is the auth kernel's job and is done by the routes,
// which hold the request's actor; everything about the EMPLOYEE is here.
//
// Writes that can be refused for a reason the caller must answer with a status
// return `{ refusal: {status, body} }` instead of throwing.
// ---------------------------------------------------------------------------

function createPeopleService({ get, all, run, auth, desk }) {
  /// An employee row with its login account's fields, under the names the
  /// DTO has always read; the account is the kernel's and is asked for.
  const withLogin = (row, account) => ({
    ...row,
    login_email: account ? account.email : null,
    login_role: account ? account.role : null,
    login_is_active: account ? account.is_active : null,
    login_mobile_pin: account ? account.mobile_pin : null,
  });

  function rowToDepartmentDto(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      photoUrl: row.photo_url || '',
      isArchived: Number(row.is_archived || 0) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToEmployeeDto(row) {
    if (!row) return null;
    return {
      id: row.id,
      departmentId: row.department_id,
      name: row.name,
      role: row.role || '',
      phone: row.phone || '',
      aadharNumber: row.aadhar_number || '',
      aadharPhotoUrl: row.aadhar_photo_url || '',
      panNumber: row.pan_number || '',
      panPhotoUrl: row.pan_photo_url || '',
      address: row.address || '',
      employeePhotoUrl: row.employee_photo_url || '',
      employmentType: row.employment_type || 'in-house',
      status: row.status || 'active',
      barcodeId: row.barcode_id || '',
      email: row.email || '',
      dateOfBirth: row.date_of_birth || '',
      isArchived: Number(row.is_archived || 0) === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Unified People: the linked login/profile account (null when none).
      userId: row.user_id != null ? Number(row.user_id) : null,
      login: row.user_id != null
        ? {
            userId: Number(row.user_id),
            email: row.login_email || '',
            role: row.login_role || '',
            isActive: Number(row.login_is_active || 0) === 1,
            // The 4-digit staff login code is stored hashed (kernel/pin-hash.js):
            // whether there is one, never what it is. `loginCode` stays for
            // older clients and is always empty.
            loginCode: '',
            hasLoginCode: Boolean(row.login_mobile_pin),
          }
        : null,
    };
  }

  // Re-fetch an employee joined to its linked login account (for DTOs that need
  // the unified People shape after a write).
  async function getEmployeeWithLogin(id) {
    const row = await get('SELECT e.* FROM employees e WHERE e.id = ?', [id]);
    if (!row) return row;
    const account = row.user_id == null ? null : (await desk.ask('accounts.users.get', { id: row.user_id })).row;
    return withLogin(row, account);
  }

  // --- departments ----------------------------------------------------------

  async function listDepartments() {
    const rows = await all('SELECT * FROM departments WHERE is_archived = 0 ORDER BY name ASC');
    return rows.map(rowToDepartmentDto);
  }

  async function createDepartment(body) {
    const { name, description = '', photoUrl = '' } = body;
    if (!name || name.trim() === '') {
      return { refusal: { status: 400, body: { success: false, error: 'Name is required' } } };
    }
    const now = new Date().toISOString();
    const result = await run(
      'INSERT INTO departments (name, description, photo_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description.trim(), photoUrl, now, now],
    );
    const row = await get('SELECT * FROM departments WHERE id = ?', [result.lastID]);
    return { id: result.lastID, row, dto: rowToDepartmentDto(row) };
  }

  async function updateDepartment(id, body) {
    const { name, description, photoUrl } = body;
    const existing = await get('SELECT * FROM departments WHERE id = ?', [id]);
    if (!existing) {
      return { refusal: { status: 404, body: { success: false, error: 'Department not found' } } };
    }
    const newName = name !== undefined ? name.trim() : existing.name;
    const newDesc = description !== undefined ? description.trim() : existing.description;
    const newPhoto = photoUrl !== undefined ? photoUrl : existing.photo_url;

    await run(
      'UPDATE departments SET name = ?, description = ?, photo_url = ?, updated_at = ? WHERE id = ?',
      [newName, newDesc, newPhoto, new Date().toISOString(), id],
    );
    const row = await get('SELECT * FROM departments WHERE id = ?', [id]);
    return { existing, row, dto: rowToDepartmentDto(row) };
  }

  /// A department and the people it owns. Employees are owned by their
  /// department (employees.department_id is NOT NULL), so deleting the
  /// department takes them with it; the caller does the trashing.
  async function getDepartmentWithEmployees(id) {
    const employees = await all('SELECT * FROM employees WHERE department_id = ?', [id]);
    const before = await get('SELECT * FROM departments WHERE id = ?', [id]);
    return { before, employees };
  }

  // --- employees ------------------------------------------------------------

  async function listEmployees() {
    // Unified People read: each employee joined to its login account (if any).
    const employees = await all('SELECT e.* FROM employees e WHERE e.is_archived = 0 ORDER BY e.name ASC');
    const ids = employees.map((row) => row.user_id).filter((id) => id != null);
    const accounts = new Map((await desk.ask('accounts.users.byIds', { ids })).rows.map((account) => [account.id, account]));
    return employees.map((row) => rowToEmployeeDto(withLogin(row, row.user_id == null ? null : accounts.get(row.user_id) || null)));
  }

  async function createEmployee(body) {
    const { departmentId, name, role = '', phone = '', aadharNumber = '', aadharPhotoUrl = '', panNumber = '', panPhotoUrl = '', address = '', employeePhotoUrl = '', employmentType = 'in-house', status = 'active', barcodeId = '', email = '', dateOfBirth = '' } = body;
    if (!name || !departmentId) {
      return { refusal: { status: 400, body: { success: false, error: 'Name and departmentId are required' } } };
    }
    const now = new Date().toISOString();
    const result = await run(
      'INSERT INTO employees (department_id, name, role, phone, aadhar_number, aadhar_photo_url, pan_number, pan_photo_url, address, employee_photo_url, employment_type, status, barcode_id, email, date_of_birth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [departmentId, name.trim(), role.trim(), phone.trim(), aadharNumber.trim(), aadharPhotoUrl, panNumber.trim(), panPhotoUrl, address.trim(), employeePhotoUrl, employmentType, status, barcodeId.trim(), String(email || '').trim(), String(dateOfBirth || '').trim(), now, now],
    );
    const row = await getEmployeeWithLogin(result.lastID);
    return { id: result.lastID, row, dto: rowToEmployeeDto(row) };
  }

  async function updateEmployee(id, body) {
    const { name, role, phone, aadharNumber, aadharPhotoUrl, panNumber, panPhotoUrl, address, employeePhotoUrl, employmentType, status, departmentId, barcodeId, email, dateOfBirth } = body;
    const existing = await get('SELECT * FROM employees WHERE id = ?', [id]);
    if (!existing) {
      return { refusal: { status: 404, body: { success: false, error: 'Employee not found' } } };
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
      [newName, newRole, newPhone, newAadhar, newAadharPhoto, newPan, newPanPhoto, newAddress, newEmployeePhoto, newEmpType, newStatus, newDep, newBarcodeId, newEmail, newDob, new Date().toISOString(), id],
    );
    // Keep the staff login code in sync with DOB: if the birth date changed and
    // this employee has a linked login, re-derive their DDMM code (next free).
    if (existing.user_id && newDob !== (existing.date_of_birth || '')) {
      const dobPin = auth.deriveDobPin(newDob);
      if (dobPin) {
        const pin = await auth.nextFreeMobilePin(dobPin, existing.user_id);
        await desk.ask('accounts.users.setMobilePin', { id: existing.user_id, pin, updatedAt: new Date().toISOString() });
      }
    }
    const afterRow = await get('SELECT * FROM employees WHERE id = ?', [id]);
    const row = await getEmployeeWithLogin(id);
    return { existing, afterRow, row, dto: rowToEmployeeDto(row) };
  }

  async function getEmployee(id) {
    return get('SELECT * FROM employees WHERE id = ?', [id]);
  }

  return {
    rowToDepartmentDto,
    rowToEmployeeDto,
    getEmployeeWithLogin,
    listDepartments,
    createDepartment,
    updateDepartment,
    getDepartmentWithEmployees,
    listEmployees,
    createEmployee,
    updateEmployee,
    getEmployee,
  };
}

module.exports = { createPeopleService };
