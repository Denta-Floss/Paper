'use strict';

const { withTransaction, withSavepoint } = require('../../kernel/db-kit');

// ---------------------------------------------------------------------------
// The freelancer job pool: jobs, the tasks a job breaks into, and the batches
// that hand jobs to a worker.
//
// Takes {get, all, run} plus an `inventory` port. Handing a job to a worker
// moves the assembled set out of stock, and the ledger belongs to the
// inventory module, so the two things it needs from there come in by name:
//
//   inventory.getMaterialRowByBarcode(barcode)
//   inventory.applyInventoryMovementCore(payload, { useTransaction })
//
// Two functions here are not for the routes at all. Production calls
// syncAssemblyJob when an Assembly node comes up, and
// propagateAssemblyRejection when reconciliation books scrap against one;
// they are this module's write surface for the rest of the server.
// ---------------------------------------------------------------------------

function createJobsService({ get, all, run, inventory, desk }) {
  /// An item's bill of materials is the items module's; the item and variation
  /// a material stands for is inventory's. Both are asked for.
  const bomLinesOf = async (itemId) => (await desk.ask('items.bom.lines', { itemId })).value;
  const materialLinkOf = async (barcode) => (await desk.ask('inventory.materials.linkOf', { barcode })).link;

  /// Everything the job board draws, in one read.
  async function listAll() {
    const jobs = await all('SELECT * FROM freelancer_jobs');
    const tasks = await all('SELECT * FROM freelancer_job_tasks');
    const batches = await all('SELECT * FROM freelancer_job_batches');
    return { jobs, tasks, batches };
  }

  /**
   * Handing the job to a worker means the set physically leaves the facility, so
   * that is the OUT side of its ledger.
   */
  async function issueAssemblySetsForJobs(jobIds, freelancerId) {
    for (const jobId of jobIds) {
      const job = await get(
        'SELECT id, run_id, node_id, quantity FROM freelancer_jobs WHERE id = ?',
        [jobId],
      );
      if (!job?.run_id || !job?.node_id) continue;
      const barcode = `SET-${job.run_id}-${job.node_id}`;
      const material = await inventory.getMaterialRowByBarcode(barcode);
      if (!material) continue;
      const alreadyIssued = await desk.ask('inventory.movements.issuedToWorkerQty', {
        barcode,
        referenceId: jobId,
      });
      if (Number(alreadyIssued?.qty || 0) > 0) continue;
      const qty = Math.min(
        Number(job.quantity || 0),
        Number(material.on_hand_qty || 0),
      );
      if (qty <= 0) continue;
      try {
        await inventory.applyInventoryMovementCore({
          barcode,
          movementType: 'issue',
          qty,
          reasonCode: 'issued_to_worker',
          referenceType: 'freelancer_job',
          referenceId: String(jobId),
          actor: freelancerId ? `freelancer:${freelancerId}` : 'job-assignment',
        }, { useTransaction: false });
      } catch (error) {
        console.warn(`[assembly-set] issue job ${jobId}: ${error.message}`);
      }
    }
  }

  /// Gathers jobs into one batch for a worker and issues their sets.
  async function createBatch(freelancerId, jobIds) {
    return withSavepoint(run, 'createBatch', async () => {
    const batchNumber = 'BATCH-' + Date.now();
    const result = await run(
      'INSERT INTO freelancer_job_batches (freelancer_id, batch_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [freelancerId, batchNumber, 'assigned', new Date().toISOString(), new Date().toISOString()],
    );
    const batchId = result.lastID;

    for (const jid of jobIds) {
      await run(
        'UPDATE freelancer_jobs SET batch_id = ?, updated_at = ? WHERE id = ?',
        [batchId, new Date().toISOString(), jid],
      );
    }

    // Assigning the job hands the assembled set to the worker, which means it
    // has left the facility — the OUT side of the set's ledger.
    await issueAssemblySetsForJobs(jobIds || [], freelancerId);

    return get('SELECT * FROM freelancer_job_batches WHERE id = ?', [batchId]);
    });
  }

  /// A hand-raised job: one pending job, and a task per BOM line whose
  /// material points at an item.
  async function createJob(itemId, quantity) {
    return withSavepoint(run, 'createJob', async () => {
    const result = await run(
      `INSERT INTO freelancer_jobs (batch_id, item_id, variation_leaf_node_id, quantity, status, payout_balance, created_at, updated_at)
       VALUES (NULL, ?, 0, ?, 'pending', 0, ?, ?)`,
      [itemId, quantity, new Date().toISOString(), new Date().toISOString()],
    );
    const newJobId = result.lastID;

    const bomLines = await bomLinesOf(itemId);
    for (const line of bomLines) {
      const mat = await materialLinkOf(line.material_barcode);
      if (mat && mat.linked_item_id) {
        const reqQty = (line.quantity_per_unit * quantity) * (1 + (line.wastage_percent / 100));
        await run(
          `INSERT INTO freelancer_job_tasks (job_id, item_id, variation_leaf_node_id, required_quantity, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          [newJobId, mat.linked_item_id, mat.linked_variation_leaf_node_id || 0, reqQty, new Date().toISOString(), new Date().toISOString()],
        );
      }
    }

    return get('SELECT * FROM freelancer_jobs WHERE id = ?', [newJobId]);
    });
  }

  async function setStatus(id, status) {
    await run(
      'UPDATE freelancer_jobs SET status = ?, updated_at = ? WHERE id = ?',
      [status, new Date().toISOString(), id],
    );
    return get('SELECT * FROM freelancer_jobs WHERE id = ?', [id]);
  }

  /// A job and its tasks, together or not at all. The caller owns the error
  /// path: a failed delete has to roll back, and the route does that.
  async function deleteJob(id) {
    return withTransaction(run, async () => {
      await run('DELETE FROM freelancer_job_tasks WHERE job_id = ?', [id]);
      await run('DELETE FROM freelancer_jobs WHERE id = ?', [id]);
    });
  }

  /// What one worker's card shows: their batches from the last 30 days, and
  /// the jobs and tasks in those batches.
  async function dataForFreelancer(employeeId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const isoDate = thirtyDaysAgo.toISOString();

    const batches = await all(
      'SELECT * FROM freelancer_job_batches WHERE freelancer_id = ? AND created_at >= ?',
      [employeeId, isoDate],
    );
    const batchIds = batches.map((b) => b.id);
    let jobs = [];
    let tasks = [];
    if (batchIds.length > 0) {
      jobs = await all(`SELECT * FROM freelancer_jobs WHERE batch_id IN (${batchIds.join(',')})`);
      const jobIds = jobs.map((j) => j.id);
      if (jobIds.length > 0) {
        tasks = await all(`SELECT * FROM freelancer_job_tasks WHERE job_id IN (${jobIds.join(',')})`);
      }
    }
    return { batches, jobs, tasks };
  }

  // On an assembly step nothing is machined, so what the supervisor books as
  // scrap at reconciliation is a rejection — pieces the assembler did not get
  // right. It belongs on the worker's job, which is where the card reads it from.
  // Reconciliation is the single place rejections are recorded; the job is a
  // mirror of it, never the other way round.
  async function propagateAssemblyRejection(runId, nodeId, metrics) {
    if (metrics.scrap === undefined || metrics.scrap === null) return;
    const job = await get(
      'SELECT id, quantity FROM freelancer_jobs WHERE run_id = ? AND node_id = ?',
      [runId, nodeId],
    );
    if (!job) return;
    const rejected = Math.max(0, Number(metrics.scrap) || 0);
    const note = metrics.scrapItem
      ? `Rejected at reconciliation → ${metrics.scrapItem}`
      : 'Rejected at reconciliation';
    await run(
      `UPDATE freelancer_jobs
          SET rejected_quantity = ?, rejection_note = ?, updated_at = ?
        WHERE id = ?`,
      [rejected, rejected > 0 ? note : '', new Date().toISOString(), job.id],
    );
  }

  /// Puts an Assembly node's work in the pool.
  ///
  /// A node's status can be re-set any number of times (re-queued, reopened, a
  /// second pass over the same stage), so this is keyed on (run, node) rather
  /// than inserting blind. The caller has already worked out WHICH item the job
  /// is for; this only writes it.
  async function syncAssemblyJob({ runId, nodeId, itemId, qty }) {
    return withSavepoint(run, 'syncAssemblyJob', async () => {
    const existingJob = await get(
      'SELECT * FROM freelancer_jobs WHERE run_id = ? AND node_id = ?',
      [runId, nodeId],
    );

    let jobId = null;
    const stamp = new Date().toISOString();
    if (!existingJob) {
      const result = await run(
        `INSERT INTO freelancer_jobs (batch_id, run_id, node_id, item_id, variation_leaf_node_id, quantity, status, payout_balance, created_at, updated_at)
         VALUES (NULL, ?, ?, ?, 0, ?, 'pending', 0, ?, ?)`,
        [runId, nodeId, itemId, qty, stamp, stamp],
      );
      jobId = result.lastID;
    } else if (existingJob.status === 'pending' && existingJob.batch_id === null) {
      // Still sitting unassigned in the pool — safe to re-sync it with
      // the current batch quantity and rebuild its task list.
      await run(
        'UPDATE freelancer_jobs SET item_id = ?, quantity = ?, updated_at = ? WHERE id = ?',
        [itemId, qty, stamp, existingJob.id],
      );
      await run('DELETE FROM freelancer_job_tasks WHERE job_id = ?', [existingJob.id]);
      jobId = existingJob.id;
    }
    // Otherwise the job is already batched to a freelancer or under way
    // — leave it, and their progress, alone.

    if (jobId !== null) {
      // Populate tasks from BOM
      const bomLines = await bomLinesOf(itemId);
      for (const line of bomLines) {
        // We map the material barcode back to an item if needed, but tasks schema requires item_id.
        // Since item_bom_lines has material_barcode, let's find the linked item.
        const mat = await materialLinkOf(line.material_barcode);
        if (mat && mat.linked_item_id) {
          const reqQty = (line.quantity_per_unit * qty) * (1 + (line.wastage_percent / 100));
          await run(
            `INSERT INTO freelancer_job_tasks (job_id, item_id, variation_leaf_node_id, required_quantity, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            [jobId, mat.linked_item_id, mat.linked_variation_leaf_node_id || 0, reqQty, stamp, stamp],
          );
        }
      }
    }
    });
  }

  return {
    listAll,
    issueAssemblySetsForJobs,
    createBatch,
    createJob,
    setStatus,
    deleteJob,
    dataForFreelancer,
    propagateAssemblyRejection,
    syncAssemblyJob,
  };
}

module.exports = { createJobsService };
