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
   - **Static AES** for pages that keep the key in the page or a per-domain
     rule: CryptoJS passphrase mode (OpenSSL `Salted__` + MD5 `EVP_BytesToKey`,
     trying passphrases auto-extracted from the page and from rules) and raw
     key/iv mode (`aes-128/192/256-cbc|ecb`). The in-page `CryptoJS` object's
     `decrypt` is also wrapped at runtime to capture its plaintext.
   - **Per-domain / per-template decode rules** (see below) supply site-specific
     XOR/AES keys and custom extract regexes, applied only to matching URLs.

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
| `src/crawler/decoders/aes.js` | static AES (CryptoJS passphrase mode + raw key/iv) |
| `src/crawler/decoders/rules.js` | per-domain rule matching, key/regex resolution |
| `src/crawler/decoders/` | recursive decoder pipeline + XOR + AES + runtime-sink URL harvesting |
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

## Deployment

### Docker (local / any host)

The image is built from Playwright's official base image, so Chromium and all its
OS libraries are already baked in — no `playwright install` step.

One command brings up PostgreSQL + the web service:

```bash
docker compose up --build
# open http://localhost:3000
```

Or build and run the web container against your own database:

```bash
docker build -t webclip-monitor .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgres://user:pass@host:5432/webclip_monitor" \
  webclip-monitor
```

The container starts the HTTP API, the scan worker, and the cron scheduler, and
runs the schema migration on boot. It listens on `$PORT` (default 3000).

### Render (free tier, no Blueprint)

Two resources created **separately** in the dashboard — no `render.yaml`:

**1. PostgreSQL**
- New → **PostgreSQL**, Free plan. Name it (e.g. `webclip-db`), create.
- From its page, copy the **Internal Database URL** (used by the web service in
  the same region — no SSL needed).

**2. Web Service (Docker)**
- New → **Web Service**, connect this repo.
- **Runtime: Docker** (Render auto-detects the `Dockerfile`; leave build/start
  commands empty).
- Instance type: **Free**.
- **Environment variables:**
  - `DATABASE_URL` = the Postgres **Internal Database URL** from step 1.
  - (optional) `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — or set them later in
    the web admin.
  - If you ever point it at an **External** database URL instead, also set
    `DATABASE_SSL=true`.
  - Do **not** set `PORT` — Render injects it, and the app honours it.
- **Health check path:** `/api/health`.
- Create. The schema migrates automatically on first boot.

**Free-tier caveats**
- A free web service **spins down after ~15 min idle**, so the in-process cron
  scheduler won't fire while it's asleep — scheduled rescans only run while the
  service is awake. Trigger scans manually, ping the service to keep it warm, or
  use a paid instance for reliable rescans. One-off and on-demand scans work
  regardless.
- Free instances have 512 MB RAM; Chromium is memory-hungry, so keep
  `CRAWL_CONCURRENCY` low (1–2) on free tier.
- Free Postgres is time-limited by Render's current policy; back up anything you
  need to keep.

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

## Per-domain decode rules

For sites with their own private encoding, add rules in **Settings → Per-domain
decode rules** (stored as the `decode_rules` JSON setting). Each rule targets
URLs by `match` (a regex tested against the URL; falls back to substring) and
may supply site-specific XOR keys, AES keys, and/or a custom extract regex. They
apply only to matching URLs; everything else uses the generic auto-detection.

```json
[
  {
    "match": "promo\\.example\\.com",
    "aesKeys": [{ "passphrase": "s3cret" }],
    "xorKeys": ["0x5a", "mykey"],
    "extract": "data-config=\"([^\"]+)\""
  },
  {
    "match": "cdn\\.example\\.net/lp",
    "aesKeys": [{ "key": "hex:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "iv": "hex:0102030405060708090a0b0c0d0e0f10", "mode": "cbc" }]
  }
]
```

- `aesKeys[].passphrase` — CryptoJS passphrase mode (OpenSSL `Salted__`).
- `aesKeys[].key` / `.iv` — raw key/iv as `hex:…`, `base64:…`, or plain UTF-8;
  `.mode` is `cbc` (default) or `ecb`. Key length selects AES-128/192/256.
- `xorKeys` — extra XOR keys tried on this site's ciphertext blobs.
- `extract` — a regex; capture group 1 (or the whole match) is taken as a URL.

## Web admin

- **Tasks** — create tasks (entry URL, max depth, optional cron), run on demand,
  inspect a run's webclips and full crawl tree.
- **Domains** — all tracked domains sorted by expiry risk; re-check on demand.
- **Settings** — Telegram config + test message, warn window, XOR keys, and
  per-domain decode rules (JSON).

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
