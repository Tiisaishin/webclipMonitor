import { findUrls } from './util.js';
import { TRANSFORMS } from './transforms.js';
import { decodeXor } from './xor.js';

const MAX_DEPTH = 3;        // how deep to unwrap nested obfuscation
const MAX_OUTPUTS = 4000;   // safety cap on decoded fragments per page

/**
 * Run the full decoder chain against a fetched page.
 *
 * Sources, in order of confidence:
 *   1. runtimeUrls   - URLs the browser actually hit (redirects / sub-requests)
 *   2. runtimeDecoded- plaintext captured from hooked decode/decrypt sinks
 *                      (atob, fromCharCode, decodeURIComponent, Function, ...),
 *                      which is how we recover AES/RC4/custom-crypto output
 *                      without knowing the key
 *   3. body          - rendered HTML, run through recursive static transforms
 *                      (base64/base32/base58/hex/percent/entities/escapes/
 *                       fromCharCode/char-array/rot/reverse/gzip/deflate/brotli)
 *   4. xor           - single-byte brute force + known keys
 *
 * Auto-detection is by validation: a transform's output is kept only when it
 * yields a plausible URL, so we don't need to know which scheme a page used.
 *
 * @returns {{url: string, via: string}[]}
 */
export function runDecoders({ body = '', runtimeUrls = [], runtimeDecoded = [], xorKeys = [] }) {
  const out = [];
  const seen = new Set();
  const push = (url, via) => {
    if (!url) return;
    const key = `${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url, via });
  };

  // 1. Runtime-observed navigations / requests.
  for (const u of runtimeUrls) push(u, 'runtime');

  // 2. Plaintext captured from runtime decode/decrypt sinks.
  for (const text of runtimeDecoded) {
    for (const u of findUrls(text)) push(u, 'runtime-sink');
  }

  // 3. Recursive static transforms over the rendered body.
  for (const { url, via } of expand(body)) push(url, via);

  // 4. XOR brute force / known key.
  for (const r of decodeXor(body, { extraKeys: xorKeys })) {
    for (const u of r.urls) push(u, r.via);
  }

  return out;
}

/**
 * Recursively apply every transform, harvesting URLs at each layer. Tracks the
 * decoder chain that produced each URL (e.g. "base64>gzip") so the admin can
 * see how a target was recovered.
 */
function expand(root) {
  const found = [];
  const visited = new Set();
  let budget = MAX_OUTPUTS;

  // Breadth-first so the shortest decoder chain that reveals a URL wins the
  // attribution (e.g. "base64", not "rot>rot>base64").
  const queue = [{ text: root, depth: 0, chain: [] }];
  while (queue.length) {
    const { text, depth, chain } = queue.shift();
    if (!text) continue;

    for (const u of findUrls(text)) {
      found.push({ url: u, via: chain.length ? chain.join('>') : 'plaintext' });
    }
    if (depth >= MAX_DEPTH || budget <= 0) continue;

    for (const [name, fn] of Object.entries(TRANSFORMS)) {
      let results;
      try {
        results = fn(text) || [];
      } catch {
        results = [];
      }
      for (const decoded of results) {
        if (budget <= 0) break;
        // Dedup identical intermediate outputs to bound the fan-out.
        const sig = `${decoded.length}:${decoded.slice(0, 64)}`;
        if (visited.has(sig)) continue;
        visited.add(sig);
        budget--;
        queue.push({ text: decoded, depth: depth + 1, chain: [...chain, name] });
      }
    }
  }
  return found;
}

export { findUrls };
