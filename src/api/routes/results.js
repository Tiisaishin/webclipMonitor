import { Router } from 'express';
import { many, one } from '../../db/index.js';
import { checkDomain } from '../../domain/service.js';

export const resultsRouter = Router();

// The crawl tree for a run (flat; client reconstructs via parent_id).
resultsRouter.get('/runs/:runId/tree', async (req, res) => {
  const run = await one('SELECT * FROM scan_runs WHERE id = $1', [req.params.runId]);
  if (!run) return res.status(404).json({ error: 'not found' });
  const nodes = await many(
    `SELECT id, parent_id, url, depth, discovery_method, decoded_via,
            http_status, content_type, is_webclip, error, fetched_at
       FROM scan_nodes WHERE run_id = $1 ORDER BY id`,
    [req.params.runId]
  );
  res.json({ run, nodes });
});

// Webclips (+ their urls/domains) discovered in a run.
resultsRouter.get('/runs/:runId/webclips', async (req, res) => {
  const rows = await many(
    `SELECT w.id, w.signed, w.label, n.url AS source_url,
            u.full_url, d.domain, d.expiry_date, d.status
       FROM webclips w
       JOIN scan_nodes n ON n.id = w.node_id
       LEFT JOIN webclip_urls u ON u.webclip_id = w.id
       LEFT JOIN domains d ON d.id = u.domain_id
      WHERE n.run_id = $1
      ORDER BY w.id`,
    [req.params.runId]
  );
  res.json(rows);
});

// All tracked domains, newest/expiring first.
resultsRouter.get('/domains', async (_req, res) => {
  const rows = await many(`
    SELECT * FROM domains
    ORDER BY CASE status WHEN 'expired' THEN 0 WHEN 'expiring' THEN 1
                         WHEN 'active' THEN 2 ELSE 3 END,
             expiry_date NULLS LAST
  `);
  res.json(rows);
});

// Force a re-check of one domain.
resultsRouter.post('/domains/:id/check', async (req, res) => {
  const row = await one('SELECT id FROM domains WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  // Reset last_checked_at so the recheck interval doesn't short-circuit it.
  await one(`UPDATE domains SET last_checked_at = NULL WHERE id = $1 RETURNING id`, [req.params.id]);
  const updated = await checkDomain(row.id);
  res.json(updated);
});

resultsRouter.get('/notifications', async (_req, res) => {
  const rows = await many(
    `SELECT n.*, d.domain FROM notifications n
       LEFT JOIN domains d ON d.id = n.domain_id
      ORDER BY n.sent_at DESC LIMIT 100`
  );
  res.json(rows);
});
