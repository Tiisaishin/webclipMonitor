import { chromium, devices } from 'playwright';
import { config } from '../config.js';

// A single shared browser; one isolated context per fetch so cookies/state
// don't bleed between landing pages.
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      executablePath: config.crawl.executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

// Build an iPhone-flavoured context. Playwright ships real device descriptors
// (viewport, deviceScaleFactor, mobile UA, touch). We layer a couple of extra
// iOS Safari headers on top so the landing page's device sniffing sees an
// iPhone end to end.
// Injected into every page/frame BEFORE its scripts run. Wraps the common
// decode/decrypt "sinks" so we capture the plaintext a landing page produces at
// runtime — regardless of the scheme (base64, char-code, percent, or AES/RC4/
// custom crypto whose output flows through one of these). Captured strings are
// read back after load and scanned for URLs. All wrappers are transparent
// (call the original, return its result) and failure-tolerant.
function sinkHookScript() {
  return () => {
    try {
      const store = [];
      Object.defineProperty(window, '__wcm_decoded', { get: () => store, configurable: true });
      const rec = (v) => {
        try {
          if (typeof v === 'string' && v.length > 3 && v.length < 200000 && store.length < 5000) {
            store.push(v);
          }
        } catch (e) { /* ignore */ }
      };
      const wrap = (obj, name, transform) => {
        try {
          const orig = obj[name];
          if (typeof orig !== 'function') return;
          obj[name] = function (...args) {
            const r = orig.apply(this, args);
            try { rec(transform ? transform(r, args) : r); } catch (e) { /* ignore */ }
            return r;
          };
        } catch (e) { /* ignore */ }
      };
      wrap(window, 'atob');
      wrap(window, 'decodeURIComponent');
      wrap(window, 'unescape');
      wrap(window, 'decodeURI');
      wrap(String, 'fromCharCode');
      wrap(String, 'fromCodePoint');
      // Packed/obfuscated JS reveals its source when handed to Function(...).
      try {
        const _Function = window.Function;
        const Wrapped = function (...args) {
          try { rec(args.join(' ')); } catch (e) { /* ignore */ }
          return _Function.apply(this, args);
        };
        Wrapped.prototype = _Function.prototype;
        window.Function = Wrapped;
      } catch (e) { /* ignore */ }
      // CryptoJS is the usual in-page AES/RC4 lib. addInitScript runs before
      // the page loads it, so trap the assignment and wrap its decrypt to
      // record the decoded plaintext (WordArray -> Utf8).
      try {
        let _cj;
        const wrapCrypto = (cj) => {
          try {
            const utf8 = cj && cj.enc && cj.enc.Utf8;
            for (const algo of ['AES', 'DES', 'TripleDES', 'RC4', 'RC4Drop', 'Rabbit']) {
              const mod = cj && cj[algo];
              if (!mod || typeof mod.decrypt !== 'function') continue;
              const orig = mod.decrypt.bind(mod);
              mod.decrypt = function (...a) {
                const r = orig(...a);
                try { rec(r.toString(utf8)); } catch (e) { /* ignore */ }
                return r;
              };
            }
          } catch (e) { /* ignore */ }
        };
        Object.defineProperty(window, 'CryptoJS', {
          configurable: true,
          get() { return _cj; },
          set(v) { _cj = v; wrapCrypto(v); },
        });
      } catch (e) { /* ignore */ }

      // Binary -> text (fetch(...).arrayBuffer() then TextDecoder, WebCrypto out).
      try {
        if (window.TextDecoder) {
          const _decode = TextDecoder.prototype.decode;
          TextDecoder.prototype.decode = function (...a) {
            const r = _decode.apply(this, a);
            rec(r);
            return r;
          };
        }
      } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  };
}

function iphoneContextOptions() {
  const device = devices[config.crawl.deviceProfile] || devices['iPhone 13'];
  return {
    ...device,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      // iOS Safari advertises these; some cloakers gate on them.
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  };
}

/**
 * Fetch a URL as an iPhone. Returns:
 * {
 *   url, finalUrl, status, contentType, body (string|null), buffer (Buffer|null),
 *   redirectChain: [url...], subRequests: [{url, resourceType}], error
 * }
 *
 * We capture the full redirect chain and every sub-request URL the page issues,
 * because obfuscated landing pages frequently reveal their real target only at
 * runtime (a fetch/XHR/navigation fired by decoded JS).
 */
export async function fetchAsIphone(url) {
  const browser = await getBrowser();
  const context = await browser.newContext(iphoneContextOptions());
  await context.addInitScript(sinkHookScript());
  const page = await context.newPage();

  const subRequests = [];
  page.on('request', (req) => {
    subRequests.push({ url: req.url(), resourceType: req.resourceType() });
  });

  // Capture every URL the MAIN frame navigates to — this covers JS redirects
  // (location.href/replace/assign), meta refresh, and multi-step hops, not just
  // HTTP 30x. The entry is itself the first navigation; later ones are jumps.
  const navChain = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navChain.push(frame.url());
  });

  // Serving a .mobileconfig makes the browser start a *download* rather than a
  // navigation (this is exactly how iOS hands a profile to Settings). Capture
  // it so we can read the profile bytes.
  let capturedDownload = null;
  page.on('download', (dl) => { capturedDownload = dl; });

  const result = {
    url,
    finalUrl: url,
    status: null,
    contentType: null,
    body: null,
    buffer: null,
    redirectChain: [],
    subRequests,
    links: [],
    title: null,
    description: null,
    runtimeDecoded: [],
    error: null,
  };

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawl.navTimeoutMs,
    });

    // Let JS / meta-refresh redirects land: wait for the network to settle.
    const settleMs = Math.min(config.crawl.navTimeoutMs, 6000);
    await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});

    // Delayed jumps (setTimeout redirect, meta refresh with a delay) don't
    // generate network activity, so networkidle returns before they fire. If we
    // haven't navigated away yet but the page looks like a redirect page, wait
    // for location to actually change (bounded — only for suspected jump pages,
    // so normal pages aren't slowed down).
    if (page.url() === url) {
      const mightJump = await page.evaluate(() => {
        const h = document.documentElement ? document.documentElement.innerHTML : '';
        return /location\s*\.\s*(href|replace|assign)|location\s*=|http-equiv=["']?refresh/i.test(h);
      }).catch(() => false);
      if (mightJump) {
        await page.waitForFunction((u) => location.href !== u, url, { timeout: 4000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
      }
    }

    result.finalUrl = page.url();

    if (response) {
      result.status = response.status();
      const headers = response.headers();
      result.contentType = headers['content-type'] || null;

      // Reconstruct redirect chain.
      let req = response.request();
      const chain = [];
      let redirected = req.redirectedFrom();
      while (redirected) {
        chain.unshift(redirected.url());
        redirected = redirected.redirectedFrom();
      }
      result.redirectChain = chain;

      // Capture both text and raw bytes; webclips are binary-ish (signed plist).
      try {
        result.buffer = await response.body();
      } catch {
        result.buffer = null;
      }
    }

    // HTML content after JS has run — this is what we scrape and decode.
    try {
      result.body = await page.content();
    } catch {
      // If content() fails (e.g. a direct binary download), fall back to buffer.
      result.body = result.buffer ? result.buffer.toString('utf8') : null;
    }

    // Structured links from the rendered DOM. The browser resolves these to
    // absolute URLs for us, so relative hrefs (/lp1) are handled correctly.
    try {
      result.links = await page.evaluate(() => {
        const urls = new Set();
        const add = (u) => { if (u) urls.add(u); };
        document.querySelectorAll('a[href]').forEach((a) => add(a.href));
        document.querySelectorAll('[src]').forEach((e) => add(e.src));
        document.querySelectorAll('iframe[src]').forEach((e) => add(e.src));
        document.querySelectorAll('form[action]').forEach((f) => add(f.action));
        // <meta http-equiv="refresh" content="0;url=..."> (may be quoted/spaced)
        document.querySelectorAll('meta[http-equiv="refresh" i]').forEach((m) => {
          const c = m.getAttribute('content') || '';
          const match = c.match(/url\s*=\s*['"]?([^'"\s]+)/i);
          if (match) { try { add(new URL(match[1], location.href).href); } catch (e) {} }
        });
        return [...urls];
      });
    } catch {
      result.links = [];
    }

    // Merge JS/meta navigations into the redirect chain (dedup; drop the entry
    // URL and the final URL, which are represented elsewhere). What's left are
    // the intermediate hops a jump passed through.
    const strip = (u) => (u || '').replace(/#.*$/, '').replace(/\/$/, '');
    const seenNav = new Set([strip(url), strip(result.finalUrl)]);
    const mergedChain = [...result.redirectChain];
    for (const u of navChain) {
      const s = strip(u);
      if (s && !seenNav.has(s)) { seenNav.add(s); mergedChain.push(u); }
    }
    result.redirectChain = mergedChain;

    // Landing-page metadata + runtime-captured decoded plaintext.
    try {
      const meta = await page.evaluate(() => ({
        title: document.title || null,
        description:
          document.querySelector('meta[name="description" i]')?.content ||
          document.querySelector('meta[property="og:description" i]')?.content ||
          null,
        decoded: Array.isArray(window.__wcm_decoded) ? window.__wcm_decoded.slice(0, 5000) : [],
      }));
      result.title = meta.title;
      result.description = meta.description;
      result.runtimeDecoded = meta.decoded || [];
    } catch {
      /* page may have been torn down (e.g. a download) */
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // A download interrupting navigation is a success for us: read its bytes.
    if (capturedDownload || /download is starting/i.test(msg)) {
      const dl = capturedDownload || await page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      if (dl) {
        try {
          const stream = await dl.createReadStream();
          result.buffer = await streamToBuffer(stream);
          result.finalUrl = dl.url();
          const name = dl.suggestedFilename() || '';
          if (/\.mobileconfig$/i.test(name)) result.contentType = 'application/x-apple-aspen-config';
          result.error = null;
        } catch (e) {
          result.error = `download read failed: ${e.message}`;
        }
      } else {
        result.error = msg;
      }
    } else {
      result.error = msg;
    }
  } finally {
    await context.close().catch(() => {});
  }

  return result;
}
