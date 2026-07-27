import type { Db } from './store.ts';
import { sql } from 'drizzle-orm';

/**
 * Schema as plain, idempotent SQL.
 *
 * Kept readable on purpose: a reviewer should be able to see exactly what runs
 * against the database, and every statement is `IF NOT EXISTS` so applying it
 * twice (two workers booting at once, a re-run after a crash) is a no-op.
 *
 * The unique and primary-key constraints here are load-bearing, not hygiene:
 * `comments.id` is what makes re-ingesting a page idempotent, and
 * `webhook_deliveries.delivery_id` is what makes a re-delivered webhook a no-op.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS repos (
  id        serial PRIMARY KEY,
  owner     text NOT NULL,
  name      text NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS repos_owner_name_uq ON repos (owner, name);

CREATE TABLE IF NOT EXISTS comments (
  id               text PRIMARY KEY,
  repo_id          integer NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr               integer NOT NULL,
  reviewer         text NOT NULL,
  author_login     text NOT NULL,
  path             text NOT NULL,
  line             integer,
  severity         text NOT NULL,
  body_length      integer NOT NULL,
  created_at       timestamptz NOT NULL,
  thread_outdated  boolean NOT NULL,
  thread_resolved  boolean NOT NULL,
  pr_state         text NOT NULL,
  ingested_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_repo_reviewer_idx ON comments (repo_id, reviewer);
CREATE INDEX IF NOT EXISTS comments_repo_created_idx  ON comments (repo_id, created_at);

CREATE TABLE IF NOT EXISTS backfills (
  id                 serial PRIMARY KEY,
  repo_id            integer NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'queued',
  cursor             text,
  pages_done         integer NOT NULL DEFAULT 0,
  prs_ingested       integer NOT NULL DEFAULT 0,
  comments_ingested  integer NOT NULL DEFAULT 0,
  max_pages          integer NOT NULL DEFAULT 20,
  last_error         text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backfills_repo_idx ON backfills (repo_id);

CREATE TABLE IF NOT EXISTS scorecards (
  id             serial PRIMARY KEY,
  repo_id        integer NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  reviewer       text NOT NULL,
  window_from    text NOT NULL,
  window_to      text NOT NULL,
  decided        integer NOT NULL,
  acted_on       integer NOT NULL,
  effectiveness  real NOT NULL,
  payload        jsonb NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scorecards_window_uq
  ON scorecards (repo_id, reviewer, window_from, window_to);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  text PRIMARY KEY,
  event        text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_calls (
  id                     serial PRIMARY KEY,
  repo_id                integer REFERENCES repos(id) ON DELETE SET NULL,
  kind                   text NOT NULL,
  duration_ms            integer NOT NULL,
  retries                integer NOT NULL DEFAULT 0,
  rate_limit_remaining   integer,
  at                     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_calls_at_idx ON api_calls (at);
`;

export async function migrate(db: Db): Promise<void> {
  await db.execute(sql.raw(MIGRATION_SQL));
}
