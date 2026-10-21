import { one, query } from './db/index.js';
import { config } from './config.js';

// Settings live in the DB (editable via the web admin). Telegram credentials
// are web-admin only — no env fallback. Only the expiry warn window falls back
// to its env-derived default.
const ENV_FALLBACK = {
  expiry_warn_days: String(config.domain.expiryWarnDays),
};

export async function getSetting(key) {
  const row = await one('SELECT value FROM settings WHERE key = $1', [key]);
  if (row && row.value != null && row.value !== '') return row.value;
  return ENV_FALLBACK[key] ?? null;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

export async function getAllSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const merged = { ...ENV_FALLBACK };
  for (const r of rows) if (r.value != null && r.value !== '') merged[r.key] = r.value;
  return merged;
}
