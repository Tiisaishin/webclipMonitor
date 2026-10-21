import { one, query } from '../db/index.js';
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { lookupExpiry, classify } from './checker.js';
import { sendTelegram, formatExpiryAlert } from '../notify/telegram.js';

// Upsert a domain row, returning its id. Does not trigger a check.
export async function upsertDomain(domain) {
  const row = await one(
    `INSERT INTO domains (domain) VALUES ($1)
     ON CONFLICT (domain) DO UPDATE SET domain = EXCLUDED.domain
     RETURNING id`,
    [domain]
  );
  return row.id;
}

// Should we (re)check this domain now?
function isStale(lastChecked) {
  if (!lastChecked) return true;
  const ageMs = Date.now() - new Date(lastChecked).getTime();
  return ageMs >= config.domain.recheckHours * 60 * 60 * 1000;
}

/**
 * Check a single domain's expiry (respecting the recheck interval), persist the
 * result, and fire a Telegram alert on expired/expiring — once per status
 * transition (guarded by the notifications table).
 */
export async function checkDomain(domainId, context = {}) {
  const row = await one('SELECT * FROM domains WHERE id = $1', [domainId]);
  if (!row) return null;

  if (!isStale(row.last_checked_at) && row.status && row.status !== 'unknown') {
    return row; // fresh enough
  }

  const warnDays = Number.parseInt(await getSetting('expiry_warn_days'), 10) || config.domain.expiryWarnDays;
  const { expiry, registrar, error } = await lookupExpiry(row.domain);
  const status = classify(expiry, warnDays);

  await query(
    `UPDATE domains
       SET expiry_date = $2, status = $3, registrar = $4,
           last_checked_at = now(), check_error = $5
     WHERE id = $1`,
    [domainId, expiry || null, status, registrar || null, error || null]
  );

  if (status === 'expired' || status === 'expiring') {
    await maybeNotify(domainId, row.domain, expiry, status, context);
  }

  return { ...row, expiry_date: expiry, status, registrar };
}

// Send at most one notification per (domain, status) unless the previous one
// was for a different status (active -> expiring -> expired all notify once).
async function maybeNotify(domainId, domain, expiry, status, context) {
  const existing = await one(
    `SELECT reason FROM notifications
      WHERE domain_id = $1 AND reason = $2
      ORDER BY sent_at DESC LIMIT 1`,
    [domainId, status]
  );
  if (existing) return;

  const text = formatExpiryAlert({
    domain,
    expiry,
    status,
    taskName: context.taskName,
    entryUrl: context.entryUrl,
    webclipUrl: context.webclipUrl,
  });

  const res = await sendTelegram(text);
  await query(
    `INSERT INTO notifications (domain_id, channel, reason, payload) VALUES ($1, 'telegram', $2, $3)`,
    [domainId, status, res.ok ? text : `FAILED: ${res.error}\n\n${text}`]
  );
  if (!res.ok) console.warn(`[notify] telegram failed for ${domain}: ${res.error}`);
}
