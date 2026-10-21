import { Router } from 'express';
import { getAllSettings, setSetting } from '../../settings.js';
import { sendTelegram } from '../../notify/telegram.js';

export const settingsRouter = Router();

// Keys the web admin is allowed to manage.
const ALLOWED = new Set([
  'telegram_bot_token',
  'telegram_chat_id',
  'expiry_warn_days',
  'xor_keys',
]);

// Mask secrets on read.
function maskSecrets(settings) {
  const out = { ...settings };
  if (out.telegram_bot_token) {
    const t = out.telegram_bot_token;
    out.telegram_bot_token_set = true;
    out.telegram_bot_token = t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••';
  } else {
    out.telegram_bot_token_set = false;
  }
  return out;
}

settingsRouter.get('/', async (_req, res) => {
  const settings = await getAllSettings();
  res.json(maskSecrets(settings));
});

settingsRouter.put('/', async (req, res) => {
  const body = req.body || {};
  const applied = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED.has(key)) continue;
    await setSetting(key, String(value));
    applied.push(key);
  }
  const settings = await getAllSettings();
  res.json({ applied, settings: maskSecrets(settings) });
});

// Send a test Telegram message using current settings.
settingsRouter.post('/telegram/test', async (_req, res) => {
  const result = await sendTelegram('✅ WebClip Monitor test message');
  res.status(result.ok ? 200 : 400).json(result);
});
