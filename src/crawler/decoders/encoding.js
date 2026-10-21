import { findUrls, looksMeaningful, printableRatio } from './util.js';

// Pull out long base64-ish and hex-ish blobs and try to decode them.
const B64_RE = /[A-Za-z0-9+/=]{24,}/g;
const HEX_RE = /(?:[0-9a-fA-F]{2}){16,}/g;

function tryBase64(blob) {
  try {
    const decoded = Buffer.from(blob, 'base64').toString('utf8');
    if (printableRatio(decoded) > 0.85 && looksMeaningful(decoded)) return decoded;
  } catch {
    /* ignore */
  }
  return null;
}

function tryHex(blob) {
  try {
    const decoded = Buffer.from(blob, 'hex').toString('utf8');
    if (printableRatio(decoded) > 0.85 && looksMeaningful(decoded)) return decoded;
  } catch {
    /* ignore */
  }
  return null;
}

function tryUnescape(text) {
  const candidates = [];
  // \uXXXX and %XX escaping is extremely common in JS-built landing pages.
  try {
    candidates.push(JSON.parse(`"${text.replace(/"/g, '\\"')}"`));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(decodeURIComponent(text));
  } catch {
    /* ignore */
  }
  return candidates.filter((c) => c && c !== text && looksMeaningful(c));
}

/**
 * Generic encoding decoder. Scans the document for encoded blobs and whole-doc
 * escaping, returning any URLs that fall out.
 * @returns {{via: string, urls: string[]}[]}
 */
export function decodeEncoding(text) {
  if (!text) return [];
  const results = [];

  // Whole-document unescaping first.
  for (const unescaped of tryUnescape(text)) {
    const urls = findUrls(unescaped);
    if (urls.length) results.push({ via: 'encoding:unescape', urls });
  }

  // Base64 blobs.
  const b64 = text.match(B64_RE) || [];
  for (const blob of b64.slice(0, 200)) {
    const decoded = tryBase64(blob);
    if (decoded) {
      const urls = findUrls(decoded);
      if (urls.length) results.push({ via: 'encoding:base64', urls });
    }
  }

  // Hex blobs.
  const hex = text.match(HEX_RE) || [];
  for (const blob of hex.slice(0, 200)) {
    const decoded = tryHex(blob);
    if (decoded) {
      const urls = findUrls(decoded);
      if (urls.length) results.push({ via: 'encoding:hex', urls });
    }
  }

  return dedupeResults(results);
}

function dedupeResults(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const urls = r.urls.filter((u) => {
      const key = `${r.via}|${u}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (urls.length) out.push({ via: r.via, urls });
  }
  return out;
}
