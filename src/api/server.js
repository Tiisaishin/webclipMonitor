import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tasksRouter } from './routes/tasks.js';
import { resultsRouter } from './routes/results.js';
import { settingsRouter } from './routes/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/tasks', tasksRouter);
  app.use('/api', resultsRouter);
  app.use('/api/settings', settingsRouter);

  // Static web admin.
  app.use(express.static(join(__dirname, '..', '..', 'public')));

  // JSON error handler.
  app.use((err, _req, res, _next) => {
    console.error('[api] error', err);
    res.status(500).json({ error: String(err.message || err) });
  });

  return app;
}
