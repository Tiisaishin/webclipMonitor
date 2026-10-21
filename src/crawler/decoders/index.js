import { findUrls } from './util.js';
import { decodeEncoding } from './encoding.js';
import { decodeXor } from './xor.js';

/**
 * Run the full decoder chain against a fetched page.
 *
 * The single most reliable "decoder" is the browser itself: `fetchAsIphone`
 * already executed the page's JS and captured the runtime redirect chain and
 * every sub-request it fired. Those runtime URLs are passed in as
 * `runtimeUrls` and treated as the highest-confidence source.
 *
 * Returns a flat list of { url, via } candidates for the orchestrator to
 * enqueue as child nodes.
 *
 * @param {object} args
 * @param {string} args.body        - rendered HTML (post-JS)
 * @param {string[]} args.runtimeUrls - URLs observed at runtime (redirects/sub-requests)
 * @param {string[]} [args.xorKeys] - optional known XOR keys from task config
 */
export function runDecoders({ body = '', runtimeUrls = [], xorKeys = [] }) {
  const out = [];
  const push = (url, via) => {
    if (url) out.push({ url, via });
  };

  // 1. Runtime-observed URLs (the JS already told us where it goes).
  for (const u of runtimeUrls) push(u, 'runtime');

  // 2. Plaintext URLs present in the rendered DOM.
  for (const u of findUrls(body)) push(u, 'plaintext');

  // 3. Generic encodings (base64 / hex / url-escape / unicode-escape).
  for (const r of decodeEncoding(body)) {
    for (const u of r.urls) push(u, r.via);
  }

  // 4. XOR brute-force / known-key.
  for (const r of decodeXor(body, { extraKeys: xorKeys })) {
    for (const u of r.urls) push(u, r.via);
  }

  return out;
}

export { findUrls };
