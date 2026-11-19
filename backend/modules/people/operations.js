'use strict';

const F = require('../../kernel/fields');

// ---------------------------------------------------------------------------
// People — what the module offers at the kernel desk.
//
//   offered to users
//     people.departments.list · .create · .update · .delete
//     people.employees.list · .create · .update · .delete
//
//   internal — asked by other modules
//     people.employees.idByBarcode     whose barcode this is, for jobs
//
// Deleting a department takes its people with it; the result carries all of
// them so the Track entries say so.
//
//     people.employees.createLogin · .linkLogin · .unlinkLogin
//
// An employee's login. Only an admin or a super admin may ask (`roles`), and
// making an account also needs `users.create_user`, exactly as the routes
// always required. The account itself is the auth kernel's: making it, its
// staff login code and the audit entry are the kernel's functions, handed in.
// Two statements here still name the kernel's `users` table directly (does
// this account exist; set its login code) until the kernel offers them.
//
// Still reached by hand: the trash (action center).
// ---------------------------------------------------------------------------

const { fromRefusal, refusing } = require('../../kernel/desk-kit');

const id = { type: 'integer', required: true, gt: 0 };
const object = { type: 'object' };
const named = { name: { type: 'string', nullable: true } };

const ADMINS = ['super_admin', 'admin'];
const employeeResult = { fields: { employee: { ...object, required: true } } };

module.exports = function peopleOperations({
  service,
  ports,
  trashAndDelete,
  trashAndDeleteMany,
  get,
  run,
  auth,
}) {
  const asUser = (ctx) => ({ user: ctx.actor?.user || null });
  const no = (status, error) => ({ ok: false, status, error });
  const employeeWithLogin = async (employeeId) => ({
    ok: true,
    employee: service.rowToEmployeeDto(await service.getEmployeeWithLogin(employeeId)),
  });

  return {
    'people.departments.list': {
      permission: 'people.read',
      summary: 'The live departments, by name.',
      output: { fields: { departments: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, departments: await service.listDepartments() }),
    },

    'people.departments.create': {
      permission: 'people.create',
      summary: 'Add a department.',
      input: { fields: named },
      output: { fields: { department: { ...object, required: true } } },
      run: async (input) => {
        const made = await service.createDepartment(input);
        if (made.refusal) return fromRefusal(made.refusal);
        return { ok: true, department: made.dto, id: made.id, row: made.row };
      },
    },

    'people.departments.update': {
      permission: 'people.update',
      summary: 'Change a department. What is left out is kept.',
      input: { fields: { id, ...named } },
      output: { fields: { department: { ...object, required: true } } },
      run: async (input) => {
        const { id: departmentId, ...body } = input;
        const saved = await service.updateDepartment(Number(departmentId), body);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return { ok: true, department: saved.dto, before: saved.existing, after: saved.row };
      },
    },

    'people.departments.delete': {
      permission: 'people.delete',
      summary: 'Move a department, and the people in it, to the trash.',
      input: { fields: { id } },
      run: async (input, ctx) => {
        const departmentId = Number(input.id);
        // Employees are owned by their department (employees.department_id is
        // NOT NULL), so they go to the trash before it does. References from
        // other modules are left for the Action Center to surface.
        const { before, employees } = await service.getDepartmentWithEmployees(departmentId);
        await trashAndDeleteMany('employees', employees.map((row) => row.id), asUser(ctx));
        await trashAndDelete('departments', departmentId, asUser(ctx));
        return { ok: true, before, employees };
      },
    },

    'people.employees.list': {
      permission: 'people.read',
      summary: 'The live employees, each with its login.',
      output: { fields: { employees: { type: 'array', required: true, items: object } } },
      run: async () => ({ ok: true, employees: await service.listEmployees() }),
    },

    'people.employees.create': {
      permission: 'people.create',
      summary: 'Add an employee.',
      input: { fields: named },
      output: { fields: { employee: { ...object, required: true } } },
      run: async (input) => {
        const made = await service.createEmployee(input);
        if (made.refusal) return fromRefusal(made.refusal);
        return { ok: true, employee: made.dto, id: made.id, row: made.row };
      },
    },

    'people.employees.update': {
      permission: 'people.update',
      summary: 'Change an employee. What is left out is kept.',
      input: { fields: { id, ...named } },
      output: { fields: { employee: { ...object, required: true } } },
      run: async (input) => {
        const { id: employeeId, ...body } = input;
        const saved = await service.updateEmployee(Number(employeeId), body);
        if (saved.refusal) return fromRefusal(saved.refusal);
        return { ok: true, employee: saved.dto, before: saved.existing, after: saved.afterRow };
      },
    },

    'people.employees.delete': {
      permission: 'people.delete',
      summary: 'Move an employee to the trash.',
      input: { fields: { id } },
      run: async (input, ctx) => {
        const employeeId = Number(input.id);
        const before = await service.getEmployee(employeeId);
        await trashAndDelete('employees', employeeId, asUser(ctx));
        return { ok: true, before };
      },
    },

    // --- an employee's login ------------------------------------------------

    'people.employees.createLogin': {
      roles: ADMINS,
      permission: 'users.create_user',
      summary: 'Make a login account for an in-house employee and link it.',
      input: {
        fields: {
          id,
          email: { type: 'string', nullable: true },
          password: { type: 'string', nullable: true },
          role: { type: 'string', nullable: true },
          // Where the request came from, for the audit entry.
          ipAddress: F.text,
          userAgent: F.text,
        },
      },
      output: employeeResult,
      run: (input, ctx) =>
        refusing(async () => {
          const employeeId = Number(input.id);
          const asker = ctx.actor?.user || {};
          const emp = await service.getEmployee(employeeId);
          if (!emp) return no(404, 'Employee not found.');
          if ((emp.employment_type || 'in-house') !== 'in-house') {
            return no(400, 'Only in-house employees can be given a login.');
          }
          if (emp.user_id) return no(409, 'This employee already has a linked login.');
          const email = String(input.email || emp.email || '').trim();
          if (!email) return no(400, 'An email is required to create a login.');
          const password = String(input.password || '');
          // Employee logins default to the 'user' (staff) role. Elevating to
          // 'admin' needs a super admin; a super admin cannot be made here.
          let role = String(input.role || 'user').trim();
          if (role === 'super_admin') return no(403, 'Cannot create a super admin from an employee.');
          if (role === 'admin' && asker.role !== 'super_admin') {
            return no(403, 'Only a super admin can grant admin access.');
          }
          if (role !== 'admin') role = 'user';

          const user = await auth.createUserAccount({
            name: emp.name,
            email,
            password,
            role,
            createdByUserId: asker.id,
          });
          await run('UPDATE employees SET user_id = ?, email = ?, updated_at = ? WHERE id = ?', [
            user.id, email, new Date().toISOString(), employeeId,
          ]);
          // Simple staff login: the employee's DDMM (from date of birth) as
          // their 4-digit code, or the next free code if that one is taken.
          const dobPin = auth.deriveDobPin(emp.date_of_birth);
          if (dobPin) {
            const pin = await auth.nextFreeMobilePin(dobPin, user.id);
            await run('UPDATE users SET mobile_pin = ? WHERE id = ?', [pin, user.id]);
          }
          await auth.logAuthEvent({
            eventType: 'user_created',
            actorUserId: asker.id,
            targetUserId: user.id,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            metadata: { role, viaEmployee: employeeId },
          });
          return employeeWithLogin(employeeId);
        }),
    },

    'people.employees.linkLogin': {
      roles: ADMINS,
      access: 'signedIn',
      summary: 'Link an in-house employee to a login account that already exists.',
      input: { fields: { id, userId: F.int } },
      output: employeeResult,
      run: (input) =>
        refusing(async () => {
          const employeeId = Number(input.id);
          const userId = Number(input.userId);
          const emp = await service.getEmployee(employeeId);
          if (!emp) return no(404, 'Employee not found.');
          if ((emp.employment_type || 'in-house') !== 'in-house') {
            return no(400, 'Only in-house employees can be linked to a login.');
          }
          if (!Number.isFinite(userId)) return no(400, 'userId is required.');
          const user = await get('SELECT id FROM users WHERE id = ?', [userId]);
          if (!user) return no(404, 'Login account not found.');
          const other = await get('SELECT id FROM employees WHERE user_id = ? AND id != ?', [userId, employeeId]);
          if (other) return no(409, 'That login is already linked to another employee.');

          await run('UPDATE employees SET user_id = ?, updated_at = ? WHERE id = ?', [
            userId, new Date().toISOString(), employeeId,
          ]);
          return employeeWithLogin(employeeId);
        }),
    },

    'people.employees.unlinkLogin': {
      roles: ADMINS,
      access: 'signedIn',
      summary: 'Unlink an employee from its login. The account itself is kept.',
      input: { fields: { id } },
      output: employeeResult,
      run: (input) =>
        refusing(async () => {
          const employeeId = Number(input.id);
          const emp = await service.getEmployee(employeeId);
          if (!emp) return no(404, 'Employee not found.');
          await run('UPDATE employees SET user_id = NULL, updated_at = ? WHERE id = ?', [
            new Date().toISOString(), employeeId,
          ]);
          return employeeWithLogin(employeeId);
        }),
    },

    'people.employees.idByBarcode': {
      internal: true,
      summary: 'The id of the employee whose barcode this is, or nothing.',
      input: { fields: { barcodeId: F.key } },
      output: { fields: { employeeId: { type: 'integer', nullable: true } } },
      run: async (input) => ({ ok: true, employeeId: await ports.employeeIdByBarcode(input.barcodeId) }),
    },
  };
};
