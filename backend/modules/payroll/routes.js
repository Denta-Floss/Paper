'use strict';

// ---------------------------------------------------------------------------
// Payroll module — HTTP routes.
//
// All 9 route registrations for payroll territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order matches
// server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerPayrollModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
  } = ctx;

app.get('/api/payroll/components', requirePermission('config.read'), async (req, res) => {
  try {
    const components = await all('SELECT * FROM payroll_components ORDER BY name ASC');
    res.json({ success: true, components });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payroll/components', requirePermission('config.write'), async (req, res) => {
  try {
    const { name, type, calculation_method, is_statutory, config_json } = req.body;
    if (!name || !type || !calculation_method) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const result = await run(`
      INSERT INTO payroll_components (name, type, calculation_method, is_statutory, config_json)
      VALUES (?, ?, ?, ?, ?)
    `, [name, type, calculation_method, is_statutory ? 1 : 0, config_json || '{}']);
    
    res.json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/payroll/employees/:id/salary-structure', requirePermission('config.read'), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const structure = await get('SELECT * FROM employee_salary_structures WHERE employee_id = ?', [userId]);
    if (!structure) {
      return res.json({ success: true, structure: null, lines: [] });
    }
    const lines = await all('SELECT * FROM employee_salary_structure_lines WHERE structure_id = ?', [structure.id]);
    res.json({ success: true, structure, lines });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/payroll/employees/:id/salary-structure', requirePermission('config.write'), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { base_salary, effective_date, lines } = req.body;
    
    await run('BEGIN TRANSACTION');
    let structure = await get('SELECT * FROM employee_salary_structures WHERE employee_id = ?', [userId]);
    if (structure) {
      await run('UPDATE employee_salary_structures SET effective_from = ? WHERE id = ?', 
        [effective_date, structure.id]);
    } else {
      const resStruct = await run('INSERT INTO employee_salary_structures (employee_id, effective_from) VALUES (?, ?)',
        [userId, effective_date]);
      structure = { id: resStruct.lastID };
    }
    
    await run('DELETE FROM employee_salary_structure_lines WHERE structure_id = ?', [structure.id]);
    if (lines && lines.length > 0) {
      for (const line of lines) {
        await run(`
          INSERT INTO employee_salary_structure_lines (structure_id, component_id, amount_or_formula, sequence)
          VALUES (?, ?, ?, ?)
        `, [structure.id, line.component_id, line.amount_or_formula, 1]);
      }
    }
    
    await run('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await run('ROLLBACK').catch(() => {});
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/payroll/runs', requirePermission('config.read'), async (req, res) => {
  try {
    const runs = await all('SELECT * FROM payroll_runs ORDER BY created_at DESC');
    res.json({ success: true, runs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payroll/runs', requirePermission('config.write'), async (req, res) => {
  try {
    const { period_start, period_end, remarks } = req.body;
    if (!period_start || !period_end) {
      return res.status(400).json({ success: false, error: 'Missing period start/end' });
    }
    const result = await run(`
      INSERT INTO payroll_runs (period_start, period_end, status, total_gross, total_net, created_by, remarks, created_at, updated_at)
      VALUES (?, ?, 'draft', 0, 0, ?, ?, ?, ?)
    `, [period_start, period_end, req.user?.id || null, remarks || '', new Date().toISOString(), new Date().toISOString()]);
    
    res.json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/payroll/runs/:id', requirePermission('config.read'), async (req, res) => {
  try {
    const runId = Number(req.params.id);
    const payrollRun = await get('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
    if (!payrollRun) return res.status(404).json({ success: false, error: 'Not found' });
    
    const details = await all('SELECT * FROM payroll_run_details WHERE run_id = ?', [runId]);
    res.json({ success: true, run: payrollRun, details });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/payroll/runs/:id/finalize', requirePermission('config.write'), async (req, res) => {
  try {
    const runId = Number(req.params.id);
    await run('UPDATE payroll_runs SET status = "finalized", updated_at = ? WHERE id = ?', [new Date().toISOString(), runId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/payroll/runs/:id/summary', requirePermission('config.read'), async (req, res) => {
  try {
    const runId = Number(req.params.id);
    const payrollRun = await get('SELECT * FROM payroll_runs WHERE id = ?', [runId]);
    if (!payrollRun) return res.status(404).send('Not found');
    
    const details = await all('SELECT * FROM payroll_run_details WHERE run_id = ?', [runId]);
    
    let csv = 'Employee ID,Gross Pay,Deductions,Net Pay\n';
    details.forEach(d => {
      csv += `${d.user_id},${d.gross_pay},${d.deductions},${d.net_pay}\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payroll_summary_' + runId + '.csv"');
    res.send(csv);
  } catch (error) {
    res.status(500).send('Error generating summary');
  }
});

};
