import { getSetting } from '../settings.js';

/**
 * Send a message via the Telegram Bot API. Token + chat id come from settings
 * (web admin) or env. Returns { ok, error }.
 */
export async function sendTelegram(text, { parseMode = 'HTML' } = {}) {
  const token = await getSetting('telegram_bot_token');
  const chatId = await getSetting('telegram_chat_id');
  if (!token || !chatId) {
    return { ok: false, error: 'telegram not configured (missing token or chat id)' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.description || `http ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatExpiryAlert({ domain, expiry, status, taskName, entryUrl, webclipUrl }) {
  const when = expiry ? new Date(expiry).toISOString().slice(0, 10) : 'unknown';
  const head = status === 'expired' ? '🔴 Domain EXPIRED' : '🟠 Domain expiring soon';
  return [
    `<b>${head}</b>`,
    `Domain: <code>${esc(domain)}</code>`,
    `Expiry: <b>${esc(when)}</b>`,
    taskName ? `Task: ${esc(taskName)}` : null,
    entryUrl ? `Entry: ${esc(entryUrl)}` : null,
    webclipUrl ? `Webclip URL: ${esc(webclipUrl)}` : null,
  ].filter(Boolean).join('\n');
}
