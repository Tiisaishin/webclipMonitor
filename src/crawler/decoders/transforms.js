import zlib from 'node:zlib';
import { printableRatio } from './util.js';

// A "transform" takes a string and returns decoded string(s). Transforms are
// applied recursively by the pipeline, so layered obfuscation (e.g.
// base64 -> gzip -> percent-encoded URL) unwraps automatically. Each transform
// is tolerant: it returns [] when the input clearly isn't its format.

const B64_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;
const B64URL_RE = /[A-Za-z0-9_-]{16,}/g;
const HEX_RE = /(?:[0-9a-fA-F]{2}){8,}/g;
const BASE32_RE = /[A-Z2-7]{16,}={0,6}/g;
const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{24,}/g;
const FROMCHARCODE_RE = /String\.fromCharCode\(\s*([0-9xa-fA-F,\s]+?)\s*\)/g;
const CHARARRAY_RE = /\[\s*(\d{1,3}(?:\s*,\s*\d{1,3}){6,})\s*\]/g;

function ok(s) {
  return typeof s === 'string' && s.length > 0 && s.length < 2_000_000 && printableRatio(s) > 0.85;
}

// --- whole-string transforms ---

function percentDecode(text) {
  const out = [];
  try {
    const d = decodeURIComponent(text);
    if (d !== text && ok(d)) out.push(d);
  } catch { /* partial / invalid */ }
  // Also try unescape() semantics (handles %uXXXX used by legacy escape()).
  try {
    const d = globalThis.unescape ? globalThis.unescape(text) : null;
    if (d && d !== text && ok(d)) out.push(d);
  } catch { /* ignore */ }
  return out;
}

function jsUnescape(text) {
  // \uXXXX, \xNN, and octal \NNN escapes.
  if (!/\\[ux0-7]/.test(text)) return [];
  const decoded = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-3]?[0-7]{1,2})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return decoded !== text && ok(decoded) ? [decoded] : [];
}

function htmlEntities(text) {
  if (!text.includes('&')) return [];
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x2F': '/', sol: '/', colon: ':' };
  const decoded = text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (named[n] !== undefined ? named[n] : m));
  return decoded !== text && ok(decoded) ? [decoded] : [];
}

function rot(text) {
  // ROT ciphers are rare in landers and easy to false-positive on, so only
  // accept a rotation that actually reveals a real URL scheme.
  if (!/[A-Za-z]/.test(text)) return [];
  const out = [];
  for (const decoded of [rotN(text, 13), rot47(text)]) {
    if (decoded !== text && ok(decoded) && /https?:\/\//i.test(decoded)) out.push(decoded);
  }
  return out;
}

function rotN(text, n) {
  return text.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + n) % 26) + 97))
             .replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + n) % 26) + 65));
}

function rot47(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : ch;
  }
  return out;
}

function reverse(text) {
  // Reversed URLs are a cheap trick; only accept it if reversing reveals a
  // real scheme (avoids fabricating garbage from arbitrary text).
  const r = text.split('').reverse().join('');
  return /https?:\/\//i.test(r) && !/https?:\/\//i.test(text) ? [r] : [];
}

function fromCharCode(text) {
  const out = [];
  let m;
  FROMCHARCODE_RE.lastIndex = 0;
  while ((m = FROMCHARCODE_RE.exec(text))) {
    const codes = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const s = codes.map((c) => String.fromCharCode(c.startsWith('0x') ? parseInt(c, 16) : parseInt(c, 10))).join('');
      if (ok(s)) out.push(s);
    } catch { /* ignore */ }
  }
  return out;
}

function charArray(text) {
  const out = [];
  let m;
  CHARARRAY_RE.lastIndex = 0;
  while ((m = CHARARRAY_RE.exec(text))) {
    const codes = m[1].split(',').map((x) => parseInt(x.trim(), 10));
    if (codes.some((c) => c < 32 || c > 126)) continue; // not ascii text
    const s = codes.map((c) => String.fromCharCode(c)).join('');
    if (ok(s)) out.push(s);
  }
  return out;
}

// --- blob transforms (decode then maybe decompress) ---

function decompress(buf) {
  const out = [];
  for (const fn of [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync, zlib.brotliDecompressSync]) {
    try {
      const s = fn(buf).toString('utf8');
      if (ok(s)) out.push(s);
    } catch { /* not this format */ }
  }
  return out;
}

function decodeBlobs(text, { regex, toBuf }) {
  const out = [];
  const matches = text.match(regex) || [];
  for (const blob of matches.slice(0, 150)) {
    let buf;
    try {
      buf = toBuf(blob);
    } catch {
      continue;
    }
    if (!buf || buf.length === 0) continue;
    const asText = buf.toString('utf8');
    if (ok(asText)) out.push(asText);
    // Compressed payloads: base64/hex of a gzip/deflate/brotli stream.
    for (const d of decompress(buf)) out.push(d);
  }
  return out;
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function base58Decode(s) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const ch of s) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

/**
 * Every transform. The pipeline applies them to a string and recurses on the
 * outputs, so nested schemes unwrap. Order is not important (results are
 * validated and deduped by the caller).
 */
export const TRANSFORMS = {
  'percent': percentDecode,
  'js-escape': jsUnescape,
  'html-entity': htmlEntities,
  'rot': rot,
  'reverse': reverse,
  'fromCharCode': fromCharCode,
  'char-array': charArray,
  'base64': (t) => decodeBlobs(t, { regex: B64_RE, toBuf: (b) => Buffer.from(b, 'base64') }),
  'base64url': (t) => decodeBlobs(t, { regex: B64URL_RE, toBuf: (b) => Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64') }),
  'hex': (t) => decodeBlobs(t, { regex: HEX_RE, toBuf: (b) => Buffer.from(b, 'hex') }),
  'base32': (t) => decodeBlobs(t, { regex: BASE32_RE, toBuf: base32Decode }),
  'base58': (t) => decodeBlobs(t, { regex: BASE58_RE, toBuf: base58Decode }),
};
