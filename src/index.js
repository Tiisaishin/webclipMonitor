import { config } from './config.js';
import { setupNetworking } from './net.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/index.js';
import { createServer } from './api/server.js';
import { startWorker } from './scan/worker.js';
import { startScheduler } from './scan/scheduler.js';
import { closeBrowser } from './crawler/fetcher.js';

async function main() {
  setupNetworking();
  // Ensure schema exists before anything touches the DB.
  await migrate();

  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[http] listening on http://${config.host}:${config.port}`);
  });

  const stopWorker = startWorker();
  const stopScheduler = config.scheduler.enabled ? startScheduler() : () => {};
  if (!config.scheduler.enabled) console.log('[scheduler] disabled via ENABLE_SCHEDULER');

  async function shutdown(signal) {
    console.log(`\n[app] ${signal} received, shutting down…`);
    stopScheduler();
    await stopWorker();
    server.close();
    await closeBrowser();
    await pool.end();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[app] fatal', err);
  process.exit(1);
});
