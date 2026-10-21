// Shared helpers for decoders.

// A permissive URL matcher: http(s), protocol-relative, and the Apple
// install schemes that landing pages use to hand off a profile.
const URL_RE = /\b(?:https?:\/\/|\/\/)[^\s"'`<>()\\]+/gi;
const SCHEME_RE = /\b(?:itms-services|apple-magnifier|cydia):\/\/[^\s"'`<>()\\]+/gi;
const MOBILECONFIG_RE = /[^\s"'`<>()\\]+\.mobileconfig(?:\?[^\s"'`<>()\\]*)?/gi;

export function findUrls(text) {
  if (!text) return [];
  const out = new Set();
  for (const re of [URL_RE, SCHEME_RE, MOBILECONFIG_RE]) {
    const matches = text.match(re);
    if (matches) matches.forEach((m) => out.add(m.trim()));
  }
  return [...out];
}

// Does a decoded blob look like it carries something worth following?
export function looksMeaningful(text) {
  if (!text) return false;
  if (findUrls(text).length > 0) return true;
  if (text.includes('.mobileconfig')) return true;
  if (text.includes('com.apple.webClip')) return true;
  return false;
}

// Printable-ratio heuristic for "did this decode to sane text?"
export function printableRatio(text) {
  if (!text || text.length === 0) return 0;
  let printable = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  return printable / text.length;
}
