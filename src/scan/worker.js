import { pool, one, query } from '../db/index.js';
import { runScan } from './orchestrator.js';
import { closeBrowser } from '../crawler/fetcher.js';
import { getSetting } from '../settings.js';
import { parseRules } from '../crawler/decoders/rules.js';
import { parseIgnoreList } from '../domain/ignore.js';
import { logRun } from './logger.js';

let running = false;
let stopped = false;

// Atomically claim the oldest queued run (SKIP LOCKED => safe with >1 worker).
async function claimRun(client) {
  const { rows } = await client.query(
    `UPDATE scan_runs
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM scan_runs
         WHERE status = 'queued'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`
  );
  return rows[0] || null;
}

async function executeRun(run) {
  const task = await one('SELECT * FROM scan_tasks WHERE id = $1', [run.task_id]);
  if (!task) {
    await query(`UPDATE scan_runs SET status='error', error='task missing', finished_at=now() WHERE id=$1`, [run.id]);
    return;
  }

  const xorKeysRaw = await getSetting('xor_keys'); // comma-separated optional keys
  const globalXorKeys = xorKeysRaw ? xorKeysRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const rules = parseRules(await getSetting('decode_rules'));
  const ignoreExtra = parseIgnoreList(await getSetting('ignore_domains'));

  console.log(`[worker] run ${run.id} starting: ${task.name} (${task.entry_url}) depth=${task.max_depth}`);
  try {
    const stats = await runScan(run, task, { decodeConfig: { globalXorKeys, rules }, ignoreExtra });
    await query(
      `UPDATE scan_runs SET status='done', finished_at=now(), stats=$2 WHERE id=$1`,
      [run.id, JSON.stringify(stats)]
    );
    console.log(`[worker] run ${run.id} done`, stats);
  } catch (err) {
    console.error(`[worker] run ${run.id} failed`, err);
    await logRun(run.id, 'error', `运行异常中止：${String(err.message || err)}`);
    await query(
      `UPDATE scan_runs SET status='error', error=$2, finished_at=now() WHERE id=$1`,
      [run.id, String(err.message || err)]
    );
  }
}

async function tick() {
  if (running || stopped) return;
  running = true;
  const client = await pool.connect();
  try {
    let run;
    do {
      await client.query('BEGIN');
      run = await claimRun(client);
      await client.query('COMMIT');
      if (run) await executeRun(run);
    } while (run && !stopped);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[worker] tick error', err);
  } finally {
    client.release();
    running = false;
  }
}

export function startWorker({ intervalMs = 3000 } = {}) {
  stopped = false;
  const timer = setInterval(tick, intervalMs);
  tick();
  return async function stop() {
    stopped = true;
    clearInterval(timer);
    await closeBrowser();
  };
}

// Standalone: `npm run worker`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { setupNetworking } = await import('../net.js');
  setupNetworking();
  startWorker();
  process.on('SIGINT', async () => {
    await closeBrowser();
    await pool.end();
    process.exit(0);
  });
}
