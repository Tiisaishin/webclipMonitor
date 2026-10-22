import { query } from '../db/index.js';

// Append a line to a run's debug log (scan_logs) and mirror it to stdout.
// Best-effort: a logging failure must never break a scan.
export async function logRun(runId, level, message, data = null) {
  const line = `[run ${runId}] ${level}: ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    await query(
      `INSERT INTO scan_logs (run_id, level, message, data) VALUES ($1,$2,$3,$4)`,
      [runId, level, message, data == null ? null : JSON.stringify(data)]
    );
  } catch (err) {
    console.warn(`[log] failed to persist log for run ${runId}: ${err.message}`);
  }
}
