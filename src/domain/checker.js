import { promisify } from 'node:util';
import { createRequire } from 'node:module';

// `whois` is a CommonJS module; load it via require for reliable interop.
const require = createRequire(import.meta.url);
const whois = require('whois');
const lookupWhois = promisify(whois.lookup);

/**
 * Resolve a domain's expiry date. Tries RDAP (structured JSON, reliable) first,
 * then falls back to classic WHOIS text parsing.
 *
 * @returns {{expiry: Date|null, registrar: string|null, source: string, error: string|null}}
 */
export async function lookupExpiry(domain) {
  const viaRdap = await tryRdap(domain);
  if (viaRdap.expiry) return viaRdap;

  const viaWhois = await tryWhois(domain);
  if (viaWhois.expiry) return viaWhois;

  // Return whichever carried an error / partial info for diagnostics.
  return viaRdap.error ? viaRdap : viaWhois;
}

async function tryRdap(domain) {
  const result = { expiry: null, registrar: null, source: 'rdap', error: null };
  try {
    // rdap.org bootstraps to the correct authoritative RDAP server per TLD.
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/rdap+json' },
      redirect: 'follow',
    });
    if (!res.ok) {
      result.error = `rdap http ${res.status}`;
      return result;
    }
    const data = await res.json();

    const events = Array.isArray(data.events) ? data.events : [];
    const exp = events.find((e) => e.eventAction === 'expiration');
    if (exp && exp.eventDate) result.expiry = new Date(exp.eventDate);

    const registrar = (data.entities || []).find(
      (e) => Array.isArray(e.roles) && e.roles.includes('registrar')
    );
    if (registrar) {
      const vcard = registrar.vcardArray?.[1] || [];
      const fn = vcard.find((f) => f[0] === 'fn');
      result.registrar = fn ? fn[3] : registrar.handle || null;
    }
  } catch (err) {
    result.error = `rdap: ${err.message}`;
  }
  return result;
}

const WHOIS_EXPIRY_KEYS = [
  'registry expiry date',
  'registrar registration expiration date',
  'expiration date',
  'expiry date',
  'expire',
  'paid-till',
  'renewal date',
];

async function tryWhois(domain) {
  const result = { expiry: null, registrar: null, source: 'whois', error: null };
  try {
    const raw = await lookupWhois(domain, { follow: 2, timeout: 10000 });
    const lines = String(raw).split('\n');
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (!result.expiry && WHOIS_EXPIRY_KEYS.includes(key)) {
        const d = new Date(val);
        if (!Number.isNaN(d.getTime())) result.expiry = d;
      }
      if (!result.registrar && key === 'registrar') result.registrar = val;
    }
    if (!result.expiry) result.error = 'whois: no expiry field found';
  } catch (err) {
    result.error = `whois: ${err.message}`;
  }
  return result;
}

/**
 * Classify a domain given its expiry date and a warning window.
 * @returns {'expired'|'expiring'|'active'|'unknown'}
 */
export function classify(expiry, warnDays) {
  if (!expiry || Number.isNaN(expiry.getTime())) return 'unknown';
  const now = Date.now();
  const ms = expiry.getTime() - now;
  if (ms <= 0) return 'expired';
  if (ms <= warnDays * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}
