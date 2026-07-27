import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  uniqueIndex,
  index,
  serial,
} from 'drizzle-orm/pg-core';

/**
 * Postgres is the source of truth; Redis only carries in-flight queue state.
 * A measurement product's record IS the product, so durability and idempotency
 * here are correctness requirements rather than niceties: a double-counted
 * comment is not a slow query, it is a wrong number on a scorecard.
 */

export const repos = pgTable(
  'repos',
  {
    id: serial('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('repos_owner_name_uq').on(t.owner, t.name)],
);

/**
 * Raw review-comment facts, one row per thread.
 *
 * The primary key is the deterministic hash of (repo, pr, author, path, line,
 * createdAt) computed by the engine, which is what makes re-ingesting the same
 * pull request a no-op. That single decision is what delivers exactly-once
 * counting under retries, resumed backfills, and re-delivered webhooks: an
 * upsert on this key cannot inflate a count no matter how many times it runs.
 *
 * Deliberately NOT stored: the derived outcome (acted_on / ignored / pending).
 * It is a pure function of the columns here, and the census taught this project
 * that resolving derived values at analysis time rather than ingest time lets a
 * classifier fix reclassify all history for free instead of demanding a rescan.
 */
export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    pr: integer('pr').notNull(),
    /** Canonical vendor name resolved from the author login. */
    reviewer: text('reviewer').notNull(),
    /** Raw author login, kept so a bot-registry update can reclassify history. */
    authorLogin: text('author_login').notNull(),
    path: text('path').notNull(),
    line: integer('line'),
    severity: text('severity').notNull(),
    bodyLength: integer('body_length').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    threadOutdated: boolean('thread_outdated').notNull(),
    threadResolved: boolean('thread_resolved').notNull(),
    prState: text('pr_state').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comments_repo_reviewer_idx').on(t.repoId, t.reviewer),
    index('comments_repo_created_idx').on(t.repoId, t.createdAt),
  ],
);

/**
 * Resumable backfill checkpoint, one row per repo.
 *
 * `cursor` is the GraphQL page cursor. A worker killed mid-walk resumes from the
 * last committed page rather than restarting, and because comments upsert on a
 * deterministic key, re-walking a page it had already partly ingested is safe.
 */
export const backfills = pgTable(
  'backfills',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    cursor: text('cursor'),
    pagesDone: integer('pages_done').notNull().default(0),
    prsIngested: integer('prs_ingested').notNull().default(0),
    commentsIngested: integer('comments_ingested').notNull().default(0),
    /** Stop after this many pages so one huge repo cannot run forever. */
    maxPages: integer('max_pages').notNull().default(20),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('backfills_repo_idx').on(t.repoId)],
);

/**
 * Scorecard snapshots. Unique per (repo, reviewer, window) so recomputing a
 * window updates in place; the history of windows is what the trend reads from.
 */
export const scorecards = pgTable(
  'scorecards',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    reviewer: text('reviewer').notNull(),
    windowFrom: text('window_from').notNull(),
    windowTo: text('window_to').notNull(),
    decided: integer('decided').notNull(),
    actedOn: integer('acted_on').notNull(),
    effectiveness: real('effectiveness').notNull(),
    /** The full Scorecard object, so the rendered result is reproducible. */
    payload: jsonb('payload').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scorecards_window_uq').on(t.repoId, t.reviewer, t.windowFrom, t.windowTo),
  ],
);

/**
 * Webhook dedupe. GitHub retries deliveries; a retry must be a no-op, so the
 * delivery id is the primary key and insertion is the idempotency check.
 */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  event: text('event').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * GitHub call ledger. Turns "backfill is expensive" into a number, and feeds the
 * shared rate limiter rather than guessing at budget.
 */
export const apiCalls = pgTable(
  'api_calls',
  {
    id: serial('id').primaryKey(),
    repoId: integer('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    durationMs: integer('duration_ms').notNull(),
    retries: integer('retries').notNull().default(0),
    rateLimitRemaining: integer('rate_limit_remaining'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_calls_at_idx').on(t.at)],
);

export type RepoRow = typeof repos.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type BackfillRow = typeof backfills.$inferSelect;
export type ScorecardRow = typeof scorecards.$inferSelect;
