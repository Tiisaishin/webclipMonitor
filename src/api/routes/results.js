import { Router } from 'express';
import { many, one, query } from '../../db/index.js';
import { checkDomain } from '../../domain/service.js';
import { classify } from '../../domain/checker.js';
import { getSetting, setSetting } from '../../settings.js';
import { config } from '../../config.js';
import { parseIgnoreList, normalizeEntry, DEFAULT_IGNORE } from '../../domain/ignore.js';

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

// Manually edit a domain: expiry date and/or status. Lets you correct a lookup
// or set a known expiry by hand. Body: {expiry_date?: ISO|null, status?}.
resultsRouter.patch('/domains/:id', async (req, res) => {
  const row = await one('SELECT * FROM domains WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  const { expiry_date, status } = req.body || {};
  const ALLOWED = new Set(['active', 'expiring', 'expired', 'unknown', 'ignored']);
  if (status !== undefined && status !== null && !ALLOWED.has(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  let expiry = undefined;
  if (expiry_date !== undefined) {
    if (expiry_date === null || expiry_date === '') expiry = null;
    else {
      const d = new Date(expiry_date);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid expiry_date' });
      expiry = d;
    }
  }
  // If the expiry was set/changed and no explicit status was given, recompute
  // the status (expired / expiring / active) from the new date.
  let effStatus = status;
  if (effStatus === undefined && expiry !== undefined && expiry) {
    const warnDays = Number.parseInt(await getSetting('expiry_warn_days'), 10) || config.domain.expiryWarnDays;
    effStatus = classify(expiry, warnDays);
  }
  const updated = await one(
    `UPDATE domains SET
       expiry_date = COALESCE($2, expiry_date),
       status = COALESCE($3, status),
       last_checked_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, expiry === undefined ? null : expiry, effStatus ?? null]
  );
  res.json(updated);
});

// Delete a domain record (and its webclip_url links / notifications via FK).
resultsRouter.delete('/domains/:id', async (req, res) => {
  await query('DELETE FROM domains WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// --- Ignore-domain list management ---

// The custom list (editable) + the built-in list (read-only).
resultsRouter.get('/ignore-domains', async (_req, res) => {
  const custom = parseIgnoreList(await getSetting('ignore_domains'));
  res.json({ custom, builtin: DEFAULT_IGNORE });
});

// Add one or many entries (deduped, normalized). Body: {domain} or {domains:[]}.
resultsRouter.post('/ignore-domains', async (req, res) => {
  const incoming = []
    .concat(req.body?.domains || [])
    .concat(req.body?.domain ? [req.body.domain] : [])
    .map(normalizeEntry).filter(Boolean);
  if (!incoming.length) return res.status(400).json({ error: 'no domain(s) provided' });
  const list = parseIgnoreList(await getSetting('ignore_domains'));
  const set = new Set(list);
  for (const d of incoming) set.add(d);
  const next = [...set];
  await setSetting('ignore_domains', next.join('\n'));
  // Mark any already-seen domains that now match as ignored.
  await query(
    `UPDATE domains SET status='ignored', last_checked_at=now()
       WHERE lower(domain) = ANY($1::text[]) AND status <> 'ignored'`,
    [incoming]
  );
  res.json({ custom: next });
});

// Remove one entry. Body: {domain}.
resultsRouter.post('/ignore-domains/remove', async (req, res) => {
  const target = normalizeEntry(req.body?.domain);
  if (!target) return res.status(400).json({ error: 'no domain provided' });
  const next = parseIgnoreList(await getSetting('ignore_domains')).filter((d) => d !== target);
  await setSetting('ignore_domains', next.join('\n'));
  res.json({ custom: next });
});

resultsRouter.get('/notifications', async (_req, res) => {
  const rows = await many(
    `SELECT n.*, d.domain FROM notifications n
       LEFT JOIN domains d ON d.id = n.domain_id
      ORDER BY n.sent_at DESC LIMIT 100`
  );
  res.json(rows);
});
