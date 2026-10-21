import plist from 'plist';
import forge from 'node-forge';
import { getDomain } from 'tldts';

const WEBCLIP_CONTENT_TYPES = [
  'application/x-apple-aspen-config',
];

/**
 * Decide whether a fetched resource is an Apple configuration profile that
 * (likely) carries a webclip. We look at content-type, URL suffix, and the
 * raw bytes themselves — any one is enough to treat it as a candidate.
 */
export function looksLikeWebclip({ url, contentType, buffer, body }) {
  if (contentType && WEBCLIP_CONTENT_TYPES.some((t) => contentType.includes(t))) {
    return true;
  }
  if (/\.mobileconfig(\?|#|$)/i.test(url || '')) return true;

  const text = bufferText(buffer) || body || '';
  if (text.includes('com.apple.webClip.managed')) return true;
  if (text.includes('<!DOCTYPE plist') && text.includes('PayloadType')) return true;
  return false;
}

function bufferText(buffer) {
  if (!buffer) return null;
  try {
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

// A signed .mobileconfig is a PKCS#7 / CMS SignedData container that wraps the
// real XML plist. Unwrap it with node-forge so we can parse the inner profile.
function unwrapSignedProfile(buffer) {
  try {
    const der = forge.util.createBuffer(buffer.toString('binary'));
    const asn1 = forge.asn1.fromDer(der);
    const p7 = forge.pkcs7.messageFromAsn1(asn1);
    if (p7 && p7.content) {
      // forge exposes the encapsulated content as a ByteBuffer.
      const content = p7.rawCapture && p7.rawCapture.content
        ? forge.asn1.toDer(p7.rawCapture.content).getBytes()
        : p7.content.getBytes();
      return Buffer.from(content, 'binary');
    }
  } catch {
    // not a PKCS7 container
  }
  return null;
}

function extractPlistText(buffer, body) {
  // Prefer the raw bytes.
  const candidates = [];
  if (buffer) {
    const text = bufferText(buffer);
    if (text && text.includes('<plist')) candidates.push(text);

    // Try unwrapping a signed container.
    const inner = unwrapSignedProfile(buffer);
    if (inner) {
      const innerText = bufferText(inner);
      if (innerText && innerText.includes('<plist')) candidates.push(innerText);
    }
  }
  if (body && body.includes('<plist')) candidates.push(body);

  for (const c of candidates) {
    // Trim to the plist envelope to drop any stray signing bytes around it.
    const start = c.indexOf('<?xml');
    const altStart = c.indexOf('<plist');
    const from = start >= 0 ? start : altStart;
    const end = c.lastIndexOf('</plist>');
    if (from >= 0 && end >= 0) {
      return { text: c.slice(from, end + '</plist>'.length), signed: candidates.length > 1 && c !== body };
    }
  }
  return null;
}

/**
 * Parse a webclip resource. Returns:
 * { signed, label, urls: [fullUrl...] }  or null if it isn't parseable.
 */
export function parseWebclip({ buffer, body }) {
  const extracted = extractPlistText(buffer, body);
  if (!extracted) return null;

  let parsed;
  try {
    parsed = plist.parse(extracted.text);
  } catch {
    return null;
  }

  const payloads = Array.isArray(parsed?.PayloadContent) ? parsed.PayloadContent : [];
  const urls = [];
  let label = parsed?.PayloadDisplayName || null;

  for (const p of payloads) {
    if (p && p.PayloadType === 'com.apple.webClip.managed' && typeof p.URL === 'string') {
      urls.push(p.URL);
      if (!label && p.Label) label = p.Label;
    }
  }

  if (urls.length === 0) return null;
  return { signed: extracted.signed, label, urls };
}

// Full URL -> registrable domain (handles multi-label TLDs via tldts).
export function urlToDomain(fullUrl) {
  try {
    return getDomain(fullUrl) || null;
  } catch {
    return null;
  }
}
