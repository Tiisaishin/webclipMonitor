import { one } from '../db/index.js';

// Enqueue a run for a task. The worker picks it up.
export async function enqueueRun(taskId) {
  const run = await one(
    `INSERT INTO scan_runs (task_id, status) VALUES ($1, 'queued') RETURNING *`,
    [taskId]
  );
  return run;
}
