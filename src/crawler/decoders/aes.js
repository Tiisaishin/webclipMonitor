import crypto from 'node:crypto';
import { findUrls, looksMeaningful, printableRatio } from './util.js';

// Static AES decryption for landing pages that encrypt their target and keep
// the key/passphrase in the page (very common with CryptoJS). Two modes:
//
//   1. CryptoJS passphrase mode — ciphertext is base64 of
//      "Salted__" + 8-byte salt + ct, and key/iv are derived from a passphrase
//      via OpenSSL's MD5 EVP_BytesToKey. We auto-detect these blobs and try
//      every configured + page-extracted passphrase.
//   2. Raw key mode — explicit key (+ optional iv) from a per-domain rule.
//
// Output is accepted only when it decodes to printable text containing a URL,
// so wrong keys are harmless.

const B64_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;
const HEX_RE = /(?:[0-9a-fA-F]{2}){16,}/g;
// Candidate passphrases: quoted string literals. The closing delimiter is
// backreferenced to the opening quote, and we match literals of any (bounded)
// length so a long literal (e.g. the ciphertext) is consumed as a unit rather
// than mis-pairing its closing quote with the next literal's opening quote. We
// then keep only passphrase-sized captures (4..64 chars) as candidates.
const STRING_LITERAL_RE = /(['"`])((?:(?!\1)[^\r\n]){4,4096})\1/g;

function evpBytesToKey(passphrase, salt, keyLen, ivLen) {
  const pass = Buffer.from(passphrase, 'utf8');
  let prev = Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (total < keyLen + ivLen) {
    const md5 = crypto.createHash('md5');
    md5.update(prev);
    md5.update(pass);
    md5.update(salt);
    prev = md5.digest();
    chunks.push(prev);
    total += prev.length;
  }
  const keyiv = Buffer.concat(chunks);
  return { key: keyiv.subarray(0, keyLen), iv: keyiv.subarray(keyLen, keyLen + ivLen) };
}

function accept(text) {
  return typeof text === 'string' && printableRatio(text) > 0.85 && looksMeaningful(text);
}

// CryptoJS default: AES-256-CBC, Pkcs7, passphrase-derived key/iv.
function decryptSalted(rawCipher, passphrase) {
  if (rawCipher.length < 16 || rawCipher.subarray(0, 8).toString('latin1') !== 'Salted__') return null;
  const salt = rawCipher.subarray(8, 16);
  const ct = rawCipher.subarray(16);
  try {
    const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    const text = out.toString('utf8');
    return accept(text) ? text : null;
  } catch {
    return null;
  }
}

function parseKeyMaterial(spec) {
  if (spec == null) return null;
  const s = String(spec);
  if (s.startsWith('hex:')) return Buffer.from(s.slice(4), 'hex');
  if (s.startsWith('base64:')) return Buffer.from(s.slice(7), 'base64');
  return Buffer.from(s, 'utf8');
}

function decryptRaw(cipherBuf, keyBuf, ivBuf, mode) {
  const bits = keyBuf.length * 8;
  if (![128, 192, 256].includes(bits)) return null;
  const algos = mode === 'ecb' ? [`aes-${bits}-ecb`] : [`aes-${bits}-cbc`];
  for (const algo of algos) {
    try {
      const iv = algo.endsWith('ecb') ? null : (ivBuf || Buffer.alloc(16));
      const decipher = crypto.createDecipheriv(algo, keyBuf, iv);
      const out = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
      const text = out.toString('utf8');
      if (accept(text)) return text;
    } catch {
      /* wrong key/mode */
    }
  }
  return null;
}

function collectBlobs(text) {
  const blobs = [];
  for (const b of (text.match(B64_RE) || []).slice(0, 120)) {
    try { blobs.push(Buffer.from(b, 'base64')); } catch { /* ignore */ }
  }
  for (const b of (text.match(HEX_RE) || []).slice(0, 120)) {
    try { blobs.push(Buffer.from(b, 'hex')); } catch { /* ignore */ }
  }
  return blobs;
}

/**
 * @param {string} text  rendered page body
 * @param {object} opts
 * @param {Array}  opts.aesKeys  rule-supplied keys:
 *   { passphrase } | { key, iv?, mode? }   (key/iv as "hex:..","base64:..",or utf8)
 * @returns {{via: string, urls: string[]}[]}
 */
export function decodeAes(text, { aesKeys = [] } = {}) {
  if (!text) return [];
  const results = [];
  const blobs = collectBlobs(text);

  // Passphrases: from rules + auto-extracted string literals (bounded).
  const passphrases = new Set();
  for (const k of aesKeys) if (k && k.passphrase) passphrases.add(String(k.passphrase));
  let m;
  STRING_LITERAL_RE.lastIndex = 0;
  let extracted = 0;
  while ((m = STRING_LITERAL_RE.exec(text)) && extracted < 1000) {
    extracted++;
    if (m[2].length >= 4 && m[2].length <= 64) passphrases.add(m[2]);
  }

  // Salted passphrase mode (CryptoJS default).
  for (const blob of blobs) {
    if (blob.length < 16 || blob.subarray(0, 8).toString('latin1') !== 'Salted__') continue;
    for (const pass of passphrases) {
      const plain = decryptSalted(blob, pass);
      if (plain) {
        const urls = findUrls(plain);
        if (urls.length) results.push({ via: 'aes-passphrase', urls });
      }
    }
  }

  // Raw key mode (explicit key from a per-domain rule).
  const rawKeys = aesKeys.filter((k) => k && k.key);
  for (const spec of rawKeys) {
    const keyBuf = parseKeyMaterial(spec.key);
    const ivBuf = spec.iv ? parseKeyMaterial(spec.iv) : null;
    if (!keyBuf) continue;
    for (const blob of blobs) {
      const plain = decryptRaw(blob, keyBuf, ivBuf, spec.mode);
      if (plain) {
        const urls = findUrls(plain);
        if (urls.length) results.push({ via: 'aes-key', urls });
      }
    }
  }

  return dedupe(results);
}

function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const urls = r.urls.filter((u) => (seen.has(u) ? false : seen.add(u)));
    if (urls.length) out.push({ via: r.via, urls });
  }
  return out;
}
