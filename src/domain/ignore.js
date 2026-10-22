// Registrable domains that are never the distribution target — third-party
// services (analytics, chat widgets, CDNs, social, platform infra) that a
// webclip/landing page commonly references. Matched domains are marked
// 'ignored': no expiry lookup, no alert, skipped on re-scan.
export const DEFAULT_IGNORE = [
  // Google
  'google.com', 'googleapis.com', 'gstatic.com', 'google-analytics.com',
  'googletagmanager.com', 'googleusercontent.com', 'doubleclick.net',
  'youtube.com', 'ytimg.com', 'recaptcha.net', 'withgoogle.com', 'goo.gl',
  // Meta
  'facebook.com', 'fbcdn.net', 'fb.com', 'instagram.com', 'whatsapp.com',
  'whatsapp.net', 'messenger.com',
  // Chat / support / analytics widgets
  'freshchat.com', 'freshworks.com', 'freshdesk.com', 'intercom.io',
  'intercomcdn.com', 'zendesk.com', 'zdassets.com', 'crisp.chat', 'tawk.to',
  'hotjar.com', 'sentry.io', 'segment.com', 'mixpanel.com', 'livechatinc.com',
  // Pure asset CDNs / infra. NOTE: general hosting/CDN domains that commonly
  // host whole landing pages (cloudfront.net, amazonaws.com, azureedge.net,
  // windows.net, fastly.net, …) are deliberately NOT ignored by default — add
  // specific ones to the ignore list yourself if needed.
  'cloudflare.com', 'cloudflareinsights.com', 'akamaihd.net', 'akamai.net',
  'jsdelivr.net', 'cdnjs.com', 'unpkg.com', 'bootstrapcdn.com', 'jquery.com',
  'fontawesome.com', 'typekit.net', 'gravatar.com',
  // Platforms
  'apple.com', 'icloud.com', 'mzstatic.com', 'microsoft.com', 'bing.com',
  'office.com', 'live.com',
  // Social
  'twitter.com', 'x.com', 't.co', 'twimg.com', 'linkedin.com', 'licdn.com',
  'tiktok.com', 'tiktokcdn.com', 'telegram.org', 't.me',
];

// Normalize a list entry: lowercase, trim, and drop a leading "*." so both
// "*.example.com" (wildcard) and "example.com" mean the same thing — match the
// domain and all its subdomains. A plain "sub.example.com" matches that host
// (and its subdomains). Matching itself is done by isIgnoredDomain below.
export function normalizeEntry(s) {
  return String(s || '').trim().toLowerCase().replace(/^\*\./, '');
}

export function parseIgnoreList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(/[\s,]+/)) {
    const e = normalizeEntry(part);
    if (e && !seen.has(e)) { seen.add(e); out.push(e); } // dedup
  }
  return out;
}

// True if `domain` equals, or is a subdomain of, any ignore entry (defaults +
// extras). `domain` is a registrable domain (tldts), so usually an exact match.
export function isIgnoredDomain(domain, extra = []) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  const list = [...DEFAULT_IGNORE, ...extra];
  return list.some((item) => {
    const it = String(item).toLowerCase();
    return it && (d === it || d.endsWith('.' + it));
  });
}
