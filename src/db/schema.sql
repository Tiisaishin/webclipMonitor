-- WebClip Monitor schema
-- Safe to run repeatedly (idempotent via IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_tasks (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  entry_url      TEXT NOT NULL,
  max_depth      INT  NOT NULL DEFAULT 5,
  -- NULL = one-off; otherwise a standard 5-field cron expression for rescans
  cron           TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per execution of a task.
CREATE TABLE IF NOT EXISTS scan_runs (
  id            BIGSERIAL PRIMARY KEY,
  task_id       BIGINT NOT NULL REFERENCES scan_tasks(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|error
  error         TEXT,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);
CREATE INDEX IF NOT EXISTS idx_scan_runs_task ON scan_runs(task_id);

-- Every URL visited within a run forms a node in the crawl tree.
CREATE TABLE IF NOT EXISTS scan_nodes (
  id                BIGSERIAL PRIMARY KEY,
  run_id            BIGINT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  parent_id         BIGINT REFERENCES scan_nodes(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  depth             INT  NOT NULL DEFAULT 0,
  discovery_method  TEXT,              -- how this URL was found from its parent
  decoded_via       TEXT,              -- which decoder produced it (if any)
  http_status       INT,
  content_type      TEXT,
  is_webclip        BOOLEAN NOT NULL DEFAULT false,
  error             TEXT,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Landing-page metadata captured per node (added after initial release).
ALTER TABLE scan_nodes ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE scan_nodes ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE scan_nodes ADD COLUMN IF NOT EXISTS final_url TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_nodes_run ON scan_nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_scan_nodes_parent ON scan_nodes(parent_id);

-- A parsed .mobileconfig / webclip payload.
CREATE TABLE IF NOT EXISTS webclips (
  id          BIGSERIAL PRIMARY KEY,
  node_id     BIGINT NOT NULL REFERENCES scan_nodes(id) ON DELETE CASCADE,
  signed      BOOLEAN NOT NULL DEFAULT false,
  label       TEXT,
  raw_size    INT,
  parsed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webclips_node ON webclips(node_id);

-- Registrable domains. Deduplicated across all tasks/runs.
CREATE TABLE IF NOT EXISTS domains (
  id               BIGSERIAL PRIMARY KEY,
  domain           TEXT UNIQUE NOT NULL,
  expiry_date      TIMESTAMPTZ,
  status           TEXT,            -- active|expiring|expired|unknown
  registrar        TEXT,
  last_checked_at  TIMESTAMPTZ,
  check_error      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);

-- The full URL(s) pulled out of each webclip, linked to their domain.
CREATE TABLE IF NOT EXISTS webclip_urls (
  id          BIGSERIAL PRIMARY KEY,
  webclip_id  BIGINT NOT NULL REFERENCES webclips(id) ON DELETE CASCADE,
  domain_id   BIGINT REFERENCES domains(id) ON DELETE SET NULL,
  full_url    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webclip_urls_webclip ON webclip_urls(webclip_id);
CREATE INDEX IF NOT EXISTS idx_webclip_urls_domain ON webclip_urls(domain_id);

-- Record of notifications we've sent, to avoid re-spamming.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  domain_id   BIGINT REFERENCES domains(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'telegram',
  reason      TEXT,              -- expired|expiring
  payload     TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_domain ON notifications(domain_id);
