// URL resolution, normalization and filtering.

const FOLLOWABLE_SCHEMES = new Set(['http:', 'https:']);
// Apple install hand-off schemes often embed the real profile URL in a query
// param (e.g. itms-services://?action=download-manifest&url=...).
const HANDOFF_SCHEMES = new Set(['itms-services:', 'apple-magnifier:', 'cydia:']);

export function resolveUrl(raw, base) {
  if (!raw) return null;
  let candidate = raw.trim();
  if (candidate.startsWith('//')) candidate = 'https:' + candidate;
  try {
    return new URL(candidate, base).href;
  } catch {
    return null;
  }
}

// Expand a hand-off scheme URL into the concrete http(s) target it references.
export function expandHandoff(raw) {
  try {
    const u = new URL(raw);
    if (!HANDOFF_SCHEMES.has(u.protocol)) return [];
    const nested = u.searchParams.get('url') || u.searchParams.get('URL');
    return nested ? [nested] : [];
  } catch {
    return [];
  }
}

export function isFollowable(url) {
  try {
    const u = new URL(url);
    if (!FOLLOWABLE_SCHEMES.has(u.protocol)) return false;
    // Reject hostless / dotless junk (e.g. decoder false positives like "//+").
    // A real web host is either a dotted name or an IP literal.
    const host = u.hostname;
    if (!host) return false;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
    if (!isIp && !host.includes('.')) return false;
    return true;
  } catch {
    return false;
  }
}

// Canonical form for dedup: drop fragment, lowercase host, sort query keys.
export function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
    let s = u.href;
    if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}
