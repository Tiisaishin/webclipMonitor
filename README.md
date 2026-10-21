# WebClip Monitor

Recursively crawl landing pages and navigation sites, decode obfuscated
payloads, extract iOS **webclips** (`.mobileconfig` profiles), resolve the real
destination domains, and alert on domain expiry via Telegram — all driven from
a web admin.

## What it does

Given an entry URL, the crawler walks the discovery tree **exhaustively**:

1. **Fetch as an iPhone.** Every page is loaded in headless Chromium using a
   Playwright iPhone device profile (mobile UA, viewport, touch) plus iOS Safari
   headers, so device-sniffing landing pages behave as they would on a phone.
2. **Discover next hops** from HTTP/JS redirects, runtime sub-requests, links,
   and iframes. Each visited page's URL, final (post-redirect) URL, `<title>`,
   and meta description are recorded.
3. **Decode payloads.** Obfuscation is handled two complementary ways:
   - **Runtime sink hooks.** Before each page's scripts run, the common
     decode/decrypt sinks (`atob`, `String.fromCharCode`/`fromCodePoint`,
     `decodeURIComponent`, `unescape`, the `Function` constructor,
     `TextDecoder.decode`) are wrapped so the plaintext they produce at runtime
     is captured. This recovers targets from **AES/RC4/custom crypto** whose key
     lives in the page, without needing the key — we just read what the page
     decrypts.
   - **Recursive static decoder chain**, auto-detected by validation (a layer is
     kept only if it yields a plausible URL). Covers base64 / base64url /
     base32 / base58 / hex, percent-encoding, HTML entities, `\u`/`\x`/octal JS
     escapes, `String.fromCharCode(...)`, char-code arrays, string reversal,
     ROT13/ROT47, and gzip/deflate/brotli — composed recursively, so layered
     schemes (e.g. `percent → base64 → gzip`) unwrap on their own. XOR
     (single-byte brute force + configured keys) runs alongside.

   Because pages also execute in a real browser, runtime redirects and the URLs
   the JS actually requests are captured directly.
4. **Detect & parse webclips.** When a node is an Apple config profile
   (by content-type, `.mobileconfig` suffix, or `com.apple.webClip.managed`
   payload), it's parsed — including unwrapping PKCS#7-signed profiles — and the
   webclip's full `URL` is extracted. A webclip node is a **leaf**; the crawler
   stops that branch but keeps exhausting all others up to `max_depth`.
5. **Check domains.** Each extracted URL's registrable domain is resolved via
   RDAP (falling back to WHOIS) for its expiry date.
6. **Alert.** Expired / soon-to-expire domains trigger a Telegram message
   (deduped per status).

Everything is persisted in PostgreSQL. Tasks can run once or on a cron schedule
for periodic rescans.

> **Scope.** This is a monitoring tool for tracking the state (liveness, domain
> expiry) of landing pages you are responsible for or already monitoring.
> Decoding only recovers the destination a page itself declares.

## Architecture

```
Web admin (public/)  ──▶  REST API (src/api)
                              │
        ┌─────────────────────┼─────────────────────┐
   scan_runs queue      scheduler (cron)        settings/telegram
        │ (SKIP LOCKED)        │
        ▼                      ▼
   worker ──▶ orchestrator (exhaustive BFS)
                 │
     ┌───────────┼───────────────┬──────────────┐
  fetcher     decoders        webclip parser   domain checker
 (Playwright) (plaintext/      (plist + PKCS7)  (RDAP → WHOIS)
   iPhone)     base64/hex/xor)
                 │
                 ▼
            PostgreSQL ──▶ Telegram notifier
```

Key modules:

| Path | Responsibility |
|------|----------------|
| `src/crawler/fetcher.js` | iPhone-emulated Playwright fetch; captures redirect chain, sub-requests, DOM links, page title/description, and runtime-decoded plaintext via sink hooks |
| `src/crawler/decoders/transforms.js` | the static transform registry (base64/32/58, hex, percent, entities, escapes, fromCharCode, char-array, reverse, rot, gzip/deflate/brotli) |
| `src/crawler/decoders/` | recursive decoder pipeline + XOR + runtime-sink URL harvesting |
| `src/crawler/webclip.js` | webclip detection, PKCS7 unwrap, plist parse, URL→domain |
| `src/crawler/urls.js` | URL resolve / normalize / dedup / hand-off scheme expansion |
| `src/scan/orchestrator.js` | exhaustive BFS crawl tree, node cap, webclip-as-leaf |
| `src/scan/worker.js` | claims queued runs (`FOR UPDATE SKIP LOCKED`) and executes |
| `src/scan/scheduler.js` | reconciles cron tasks and enqueues rescans |
| `src/domain/checker.js` | RDAP + WHOIS expiry lookup |
| `src/domain/service.js` | domain upsert, recheck interval, dedup notifications |
| `src/notify/telegram.js` | Telegram Bot API sender |
| `src/api/` | Express REST API (tasks, runs, domains, settings) |
| `public/` | vanilla-JS web admin |

## Setup

```bash
# 1. Install dependencies (Chromium is expected to be available to Playwright)
npm install

# 2. Create the database and configure env
createdb webclip_monitor
cp .env.example .env    # edit DATABASE_URL etc.

# 3. Apply the schema
npm run migrate

# 4. Run (HTTP API + worker + scheduler in one process)
npm start
```

Open the admin at `http://localhost:3000`.

You can also run the worker separately (e.g. multiple workers):

```bash
npm run worker
```

## Configuration

See `.env.example`. Notable settings:

- `DEVICE_PROFILE` — any Playwright device name (default `iPhone 13`).
- `MAX_NODES_PER_TASK` — hard cap per run to bound exhaustive crawls.
- `CRAWL_CONCURRENCY` — parallel page fetches.
- `DOMAIN_RECHECK_HOURS` — how often a domain is re-queried.
- `EXPIRY_WARN_DAYS` — lead time for "expiring soon" alerts.

Telegram token/chat id, the warn window, and optional known XOR keys can also be
set at runtime from the **Settings** tab (stored in the `settings` table,
overriding env).

## Web admin

- **Tasks** — create tasks (entry URL, max depth, optional cron), run on demand,
  inspect a run's webclips and full crawl tree.
- **Domains** — all tracked domains sorted by expiry risk; re-check on demand.
- **Settings** — Telegram config + test message, warn window, XOR keys.

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | list tasks + latest run |
| POST | `/api/tasks` | create task |
| PATCH | `/api/tasks/:id` | update task |
| DELETE | `/api/tasks/:id` | delete task |
| POST | `/api/tasks/:id/run` | enqueue a run now |
| GET | `/api/tasks/:id/runs` | runs for a task |
| GET | `/api/runs/:id/tree` | crawl tree for a run |
| GET | `/api/runs/:id/webclips` | webclips found in a run |
| GET | `/api/domains` | all tracked domains |
| POST | `/api/domains/:id/check` | force a re-check |
| GET | `/api/notifications` | recent alerts |
| GET/PUT | `/api/settings` | read / update settings |
| POST | `/api/settings/telegram/test` | send a Telegram test message |
