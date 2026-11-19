const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The payroll tables take a component, a salary structure for an employee, and
// a line joining the two.
//
// This used to open `backend/paper.db` directly: the developer's own working
// database. On a machine that has one it wrote into it (inside a transaction it
// rolled back); on a clean checkout, which is what the deploy runs on, the file
// did not exist, sqlite made an empty one, and the test failed on "no such
// table". It now builds its own database like every other test here.

test('a payroll component, a salary structure and the line that joins them', async () => {
  const tempDir = makeTempDir('paper-payroll-tables-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  const now = new Date().toISOString();
  // The demo seed has no employees, so make one, in a department of its own.
  const department = await backend.run(
    "INSERT INTO departments (name, created_at, updated_at) VALUES ('Payroll Test Department', ?, ?)",
    [now, now],
  );
  const made = await backend.run(
    "INSERT INTO employees (department_id, name, created_at, updated_at) VALUES (?, 'Payroll Test Employee', ?, ?)",
    [department.lastID, now, now],
  );
  const employee = { id: made.lastID };

  const component = await backend.run(
    'INSERT INTO payroll_components (name, type, calculation_method, is_statutory) VALUES (?, ?, ?, ?)',
    ['Basic Pay', 'earning', 'fixed', 0],
  );
  assert.ok(component.lastID > 0);

  const structure = await backend.run(
    'INSERT INTO employee_salary_structures (employee_id, effective_from) VALUES (?, ?)',
    [employee.id, now],
  );
  assert.ok(structure.lastID > 0);

  await backend.run(
    'INSERT INTO employee_salary_structure_lines (structure_id, component_id, amount_or_formula, sequence) VALUES (?, ?, ?, 1)',
    [structure.lastID, component.lastID, '25000'],
  );
  const line = await backend.get(
    'SELECT * FROM employee_salary_structure_lines WHERE structure_id = ?',
    [structure.lastID],
  );
  assert.equal(line.component_id, component.lastID);
  assert.equal(line.amount_or_formula, '25000');
});
