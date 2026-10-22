import { Router } from 'express';
import { many, one, query } from '../../db/index.js';
import { checkDomain } from '../../domain/service.js';
import { getSetting, setSetting } from '../../settings.js';
import { parseIgnoreList } from '../../domain/ignore.js';

export const resultsRouter = Router();

// The crawl tree for a run (flat; client reconstructs via parent_id).
resultsRouter.get('/runs/:runId/tree', async (req, res) => {
  const run = await one('SELECT * FROM scan_runs WHERE id = $1', [req.params.runId]);
  if (!run) return res.status(404).json({ error: 'not found' });
  const nodes = await many(
    `SELECT id, parent_id, url, final_url, title, description, depth,
            discovery_method, decoded_via, http_status, content_type,
            is_webclip, error, fetched_at
       FROM scan_nodes WHERE run_id = $1 ORDER BY id`,
    [req.params.runId]
  );
  res.json({ run, nodes });
});

// Debug log for a run.
resultsRouter.get('/runs/:runId/logs', async (req, res) => {
  const rows = await many(
    `SELECT id, level, message, data, created_at
       FROM scan_logs WHERE run_id = $1 ORDER BY id`,
    [req.params.runId]
  );
  res.json(rows);
});

// Webclips (+ their urls/domains) discovered in a run.
resultsRouter.get('/runs/:runId/webclips', async (req, res) => {
  const rows = await many(
    `SELECT w.id, w.signed, w.label, n.url AS source_url, n.title AS source_title,
            w.landing_url, w.landing_title, w.path,
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

// All tracked domains, newest/expiring first, each with its most recent
// source: the full webclip URL, the landing page + title, and the scan path.
resultsRouter.get('/domains', async (_req, res) => {
  const rows = await many(`
    SELECT d.*, s.full_url, s.landing_url, s.landing_title, s.path, s.entry_url
      FROM domains d
      LEFT JOIN LATERAL (
        SELECT u.full_url, w.landing_url, w.landing_title, w.path, t.entry_url
          FROM webclip_urls u
          JOIN webclips w ON w.id = u.webclip_id
          JOIN scan_nodes n ON n.id = w.node_id
          JOIN scan_runs r ON r.id = n.run_id
          JOIN scan_tasks t ON t.id = r.task_id
         WHERE u.domain_id = d.id
         ORDER BY u.id DESC LIMIT 1
      ) s ON true
    ORDER BY CASE d.status WHEN 'expired' THEN 0 WHEN 'expiring' THEN 1
                           WHEN 'active' THEN 2 ELSE 3 END,
             d.expiry_date NULLS LAST
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

// Mark a domain as ignored (third-party / non-distribution) and add it to the
// persistent ignore list so future scans skip it everywhere.
resultsRouter.post('/domains/:id/ignore', async (req, res) => {
  const row = await one('SELECT * FROM domains WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  const list = parseIgnoreList(await getSetting('ignore_domains'));
  if (!list.includes(row.domain.toLowerCase())) {
    list.push(row.domain.toLowerCase());
    await setSetting('ignore_domains', list.join('\n'));
  }
  await query(`UPDATE domains SET status='ignored', last_checked_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ...row, status: 'ignored' });
});

// Un-ignore: remove from the list and re-check it now.
resultsRouter.post('/domains/:id/unignore', async (req, res) => {
  const row = await one('SELECT * FROM domains WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  const list = parseIgnoreList(await getSetting('ignore_domains')).filter((d) => d !== row.domain.toLowerCase());
  await setSetting('ignore_domains', list.join('\n'));
  await query(`UPDATE domains SET status='unknown', last_checked_at=NULL WHERE id=$1`, [req.params.id]);
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
