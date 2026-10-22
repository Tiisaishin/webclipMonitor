// URL resolution, normalization and filtering.

const FOLLOWABLE_SCHEMES = new Set(['http:', 'https:']);
// Apple install hand-off schemes often embed the real profile URL in a query
// param (e.g. itms-services://?action=download-manifest&url=...).
const HANDOFF_SCHEMES = new Set(['itms-services:', 'apple-magnifier:', 'cydia:']);

// Hosts that only ever serve XML/HTML namespaces, schemas and DTDs — they turn
// up as xmlns / DOCTYPE noise, never as a page to crawl.
const NAMESPACE_HOSTS = ['w3.org', 'schema.org', 'purl.org', 'xmlsoap.org', 'oasis-open.org'];

// Static assets — never a page/landing to crawl. Note: .mobileconfig is NOT
// here (it's the target), and .json/.xml are left out (may carry data/targets).
const ASSET_EXT = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|m4v|webm|ogg|ogv|mp3|wav|m4a|aac|flac|avi|mov|flv|wmv|mkv|pdf|zip|gz|tgz|rar|7z|map|wasm|apk|ipa|dmg|exe|css\.map)(?:[?#]|$)/i;

export function isAssetUrl(url) {
  try {
    return ASSET_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// A namespace / schema / DTD reference, not a crawlable page. Covers the
// namespace hosts above and any URL whose path is a DTD/XSD/schema document
// (e.g. apple.com/DTDs/PropertyList-1.0.dtd from a .mobileconfig's DOCTYPE).
export function isNamespaceUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (NAMESPACE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    if (/\.(dtd|xsd|ent|mod)$/i.test(u.pathname)) return true;
    if (/\/dtds?\//i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

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
    if (isNamespaceUrl(url)) return false; // xmlns/DOCTYPE/DTD, not a page
    if (isAssetUrl(url)) return false;     // js/css/image/font/media, not a page
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
