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
  const page = await context.newPage();

  const subRequests = [];
  page.on('request', (req) => {
    subRequests.push({ url: req.url(), resourceType: req.resourceType() });
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
    error: null,
  };

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.crawl.navTimeoutMs,
    });

    // Give runtime redirects / JS a brief moment to fire.
    await page.waitForTimeout(1500).catch(() => {});

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
        // <meta http-equiv="refresh" content="0;url=...">
        document.querySelectorAll('meta[http-equiv="refresh" i]').forEach((m) => {
          const c = m.getAttribute('content') || '';
          const match = c.match(/url=(.+)$/i);
          if (match) add(new URL(match[1].trim(), location.href).href);
        });
        return [...urls];
      });
    } catch {
      result.links = [];
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
