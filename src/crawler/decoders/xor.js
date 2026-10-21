import { findUrls, looksMeaningful, printableRatio } from './util.js';

const B64_RE = /[A-Za-z0-9+/=]{24,}/g;
const HEX_RE = /(?:[0-9a-fA-F]{2}){16,}/g;

function xorBytes(bytes, key) {
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ key[i % key.length];
  }
  return out;
}

// Collect candidate ciphertext blobs from the document: base64/hex blobs, plus
// any inline string assigned to a variable (common in XOR-packed landers).
function collectBlobs(text) {
  const blobs = [];
  (text.match(B64_RE) || []).slice(0, 100).forEach((b) => {
    try {
      blobs.push(Buffer.from(b, 'base64'));
    } catch {
      /* ignore */
    }
  });
  (text.match(HEX_RE) || []).slice(0, 100).forEach((b) => {
    try {
      blobs.push(Buffer.from(b, 'hex'));
    } catch {
      /* ignore */
    }
  });
  return blobs.filter((b) => b.length >= 12);
}

function scoreDecoded(buf) {
  const s = buf.toString('utf8');
  if (printableRatio(s) < 0.9) return null;
  if (!looksMeaningful(s)) return null;
  return s;
}

/**
 * XOR decoder. For each candidate ciphertext blob, brute-force single-byte
 * keys (0-255) and try a handful of short multi-byte keys, keeping any result
 * that decodes to printable text containing a URL. This is a detection
 * heuristic — it does not assume a particular key, it validates by whether the
 * output is a plausible URL/profile.
 */
export function decodeXor(text, { extraKeys = [] } = {}) {
  if (!text) return [];
  const results = [];
  const blobs = collectBlobs(text);

  for (const blob of blobs) {
    // Single-byte keys.
    for (let k = 1; k < 256; k++) {
      const decoded = xorBytes(blob, Buffer.from([k]));
      const s = scoreDecoded(decoded);
      if (s) {
        const urls = findUrls(s);
        if (urls.length) {
          results.push({ via: `xor:1byte:0x${k.toString(16).padStart(2, '0')}`, urls });
        }
      }
    }

    // User/config-supplied multi-byte keys (e.g. a known per-template key).
    for (const key of extraKeys) {
      const keyBuf = Buffer.from(String(key), 'utf8');
      if (keyBuf.length === 0) continue;
      const decoded = xorBytes(blob, keyBuf);
      const s = scoreDecoded(decoded);
      if (s) {
        const urls = findUrls(s);
        if (urls.length) results.push({ via: `xor:key:${key}`, urls });
      }
    }
  }

  return dedupe(results);
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const urls = r.urls.filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
    if (urls.length) out.push({ via: r.via, urls });
  }
  return out;
}
