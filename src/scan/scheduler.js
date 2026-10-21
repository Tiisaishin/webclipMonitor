import cron from 'node-cron';
import { many } from '../db/index.js';
import { enqueueRun } from './runner.js';

// Keeps an in-memory map of taskId -> scheduled cron job. Reconciles against
// the DB periodically so edits in the web admin take effect without a restart.
const jobs = new Map();

async function reconcile() {
  const tasks = await many(
    `SELECT id, name, cron FROM scan_tasks WHERE enabled = true AND cron IS NOT NULL AND cron <> ''`
  );
  const wanted = new Map(tasks.map((t) => [t.id, t.cron]));

  // Remove jobs that no longer exist or changed schedule.
  for (const [taskId, entry] of jobs) {
    if (!wanted.has(taskId) || wanted.get(taskId) !== entry.cron) {
      entry.job.stop();
      jobs.delete(taskId);
    }
  }

  // Add new / updated jobs.
  for (const t of tasks) {
    if (jobs.has(t.id)) continue;
    if (!cron.validate(t.cron)) {
      console.warn(`[scheduler] task ${t.id} has invalid cron "${t.cron}" — skipping`);
      continue;
    }
    const job = cron.schedule(t.cron, async () => {
      try {
        await enqueueRun(t.id);
        console.log(`[scheduler] enqueued rescan for task ${t.id} (${t.name})`);
      } catch (err) {
        console.error(`[scheduler] failed to enqueue task ${t.id}`, err);
      }
    });
    jobs.set(t.id, { cron: t.cron, job });
    console.log(`[scheduler] scheduled task ${t.id} (${t.name}) @ "${t.cron}"`);
  }
}

export function startScheduler({ reconcileMs = 60000 } = {}) {
  reconcile();
  const timer = setInterval(reconcile, reconcileMs);
  return function stop() {
    clearInterval(timer);
    for (const { job } of jobs.values()) job.stop();
    jobs.clear();
  };
}
