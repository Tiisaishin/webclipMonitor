import { readFileSync, existsSync } from 'node:fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Node's global fetch (undici) does not honour HTTP(S)_PROXY env vars on its
// own. When an outbound proxy is configured (as in sandboxed CI/cloud
// environments), install a proxy-aware global dispatcher so that RDAP / Telegram
// / any fetch() calls route through it. This is a no-op when no proxy is set,
// so it stays harmless in normal deployments.
export function setupNetworking() {
  const proxyUri =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUri) return;

  let ca;
  const caPath = process.env.NODE_EXTRA_CA_CERTS || '/root/.ccr/ca-bundle.crt';
  try {
    if (existsSync(caPath)) ca = readFileSync(caPath);
  } catch {
    /* ignore */
  }

  try {
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUri, requestTls: ca ? { ca } : undefined }));
    console.log(`[net] routing fetch() through proxy ${proxyUri}`);
  } catch (err) {
    console.warn('[net] failed to configure proxy dispatcher', err.message);
  }
}
