// Per-domain / per-template decode rules.
//
// Rules are stored in the `decode_rules` setting as a JSON array. Each rule
// targets URLs by `match` (a regex tested against the URL; falls back to a
// substring test if it isn't valid regex) and supplies any of:
//
//   {
//     "match": "example\\.com",
//     "xorKeys": ["mykey", "0x5a"],
//     "aesKeys": [{ "passphrase": "s3cret" },
//                 { "key": "hex:00112233...", "iv": "hex:...", "mode": "cbc" }],
//     "extract": "data-url=\"([^\"]+)\""   // custom regex; group 1 (or whole match) is a URL
//   }
//
// resolveDecodeConfig merges all rules matching a given URL with the global
// defaults, so the crawler applies site-specific keys only where they belong.

export function parseRules(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ruleMatches(rule, url) {
  if (!rule || !rule.match) return false;
  try {
    return new RegExp(rule.match, 'i').test(url);
  } catch {
    return url.includes(rule.match);
  }
}

/**
 * @param {string} url
 * @param {{ globalXorKeys?: string[], rules?: object[] }} cfg
 * @returns {{ xorKeys: string[], aesKeys: object[], extracts: string[] }}
 */
export function resolveDecodeConfig(url, cfg = {}) {
  const xorKeys = [...(cfg.globalXorKeys || [])];
  const aesKeys = [];
  const extracts = [];

  for (const rule of cfg.rules || []) {
    if (!ruleMatches(rule, url)) continue;
    if (Array.isArray(rule.xorKeys)) xorKeys.push(...rule.xorKeys);
    if (Array.isArray(rule.aesKeys)) aesKeys.push(...rule.aesKeys);
    if (rule.extract) extracts.push(rule.extract);
  }

  return { xorKeys: [...new Set(xorKeys)], aesKeys, extracts };
}

// Apply a rule's custom extract regex to the body, returning captured URLs.
export function applyExtracts(body, extracts) {
  const urls = [];
  for (const pattern of extracts || []) {
    let re;
    try {
      re = new RegExp(pattern, 'gi');
    } catch {
      continue;
    }
    let m;
    let count = 0;
    while ((m = re.exec(body)) && count < 100) {
      urls.push(m[1] || m[0]);
      count++;
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
    }
  }
  return urls;
}
