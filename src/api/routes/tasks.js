import { Router } from 'express';
import cron from 'node-cron';
import { many, one, query } from '../../db/index.js';
import { enqueueRun } from '../../scan/runner.js';

export const tasksRouter = Router();

// List tasks with their latest run summary.
tasksRouter.get('/', async (_req, res) => {
  const rows = await many(`
    SELECT t.*,
           r.id AS last_run_id, r.status AS last_run_status,
           r.stats AS last_run_stats, r.finished_at AS last_run_finished
      FROM scan_tasks t
      LEFT JOIN LATERAL (
        SELECT * FROM scan_runs WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
      ) r ON true
     ORDER BY t.created_at DESC
  `);
  res.json(rows);
});

const SITE_TYPES = new Set(['nav', 'standalone']);

tasksRouter.post('/', async (req, res) => {
  const { name, entry_url, max_depth, cron: cronExpr, site_type } = req.body || {};
  if (!name || !entry_url) {
    return res.status(400).json({ error: 'name and entry_url are required' });
  }
  try {
    new URL(entry_url);
  } catch {
    return res.status(400).json({ error: 'entry_url is not a valid URL' });
  }
  if (cronExpr && !cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'invalid cron expression' });
  }
  if (site_type && !SITE_TYPES.has(site_type)) {
    return res.status(400).json({ error: "site_type must be 'nav' or 'standalone'" });
  }
  const depth = Number.parseInt(max_depth, 10);
  const row = await one(
    `INSERT INTO scan_tasks (name, entry_url, max_depth, site_type, cron)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, entry_url, Number.isFinite(depth) ? depth : 5, site_type || 'nav', cronExpr || null]
  );
  res.status(201).json(row);
});

tasksRouter.patch('/:id', async (req, res) => {
  const { name, entry_url, max_depth, cron: cronExpr, enabled, site_type } = req.body || {};
  if (cronExpr && !cron.validate(cronExpr)) {
    return res.status(400).json({ error: 'invalid cron expression' });
  }
  if (site_type && !SITE_TYPES.has(site_type)) {
    return res.status(400).json({ error: "site_type must be 'nav' or 'standalone'" });
  }
  const row = await one(
    `UPDATE scan_tasks SET
       name = COALESCE($2, name),
       entry_url = COALESCE($3, entry_url),
       max_depth = COALESCE($4, max_depth),
       cron = COALESCE($5, cron),
       enabled = COALESCE($6, enabled),
       site_type = COALESCE($7, site_type)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, entry_url ?? null,
     Number.isFinite(Number.parseInt(max_depth, 10)) ? Number.parseInt(max_depth, 10) : null,
     cronExpr ?? null, typeof enabled === 'boolean' ? enabled : null, site_type ?? null]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

tasksRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM scan_tasks WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// Manually trigger a run now.
tasksRouter.post('/:id/run', async (req, res) => {
  const task = await one('SELECT id FROM scan_tasks WHERE id = $1', [req.params.id]);
  if (!task) return res.status(404).json({ error: 'not found' });
  const run = await enqueueRun(task.id);
  res.status(202).json(run);
});

// Runs for a task.
tasksRouter.get('/:id/runs', async (req, res) => {
  const rows = await many(
    'SELECT * FROM scan_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.params.id]
  );
  res.json(rows);
});
