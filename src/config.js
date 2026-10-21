import 'dotenv/config';

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/webclip_monitor',
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',

  crawl: {
    concurrency: int('CRAWL_CONCURRENCY', 4),
    navTimeoutMs: int('NAV_TIMEOUT_MS', 30000),
    maxNodesPerTask: int('MAX_NODES_PER_TASK', 2000),
    deviceProfile: process.env.DEVICE_PROFILE || 'iPhone 13',
    // Optional: path to a Chromium binary (e.g. a pre-provisioned one). When
    // empty, Playwright uses the browser it manages itself.
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  },

  domain: {
    recheckHours: int('DOMAIN_RECHECK_HOURS', 24),
    expiryWarnDays: int('EXPIRY_WARN_DAYS', 14),
  },

  scheduler: {
    enabled: bool('ENABLE_SCHEDULER', true),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
};
