import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { ReviewComment, Scorecard } from '@diffhawk/core';
import { repos, comments, backfills, scorecards, webhookDeliveries, apiCalls } from './schema.ts';
import type { BackfillRow, RepoRow } from './schema.ts';

export type Db = PostgresJsDatabase<Record<string, never>>;

export function connect(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client), close: () => client.end({ timeout: 5 }) };
}

/**
 * The persistence surface the API and worker share.
 *
 * Every write here is idempotent. That is not a style preference: the worker
 * retries, backfills resume mid-page, and GitHub re-delivers webhooks, so any
 * write that could double-apply would show up as a wrong number rather than as
 * an error anyone would notice.
 */
export class ReviewStore {
  constructor(private db: Db) {}

  /** Insert-or-get a repo. Safe to call concurrently from several workers. */
  async ensureRepo(owner: string, name: string): Promise<RepoRow> {
    const [row] = await this.db
      .insert(repos)
      .values({ owner, name })
      .onConflictDoUpdate({
        target: [repos.owner, repos.name],
        // A no-op update so the RETURNING clause yields the existing row; a
        // plain DoNothing returns nothing and would force a second round trip.
        set: { owner: sql`excluded.owner` },
      })
      .returning();
    return row!;
  }

  async findRepo(owner: string, name: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(repos)
      .where(and(eq(repos.owner, owner), eq(repos.name, name)))
      .limit(1);
    return row;
  }

  /**
   * Upsert comments by their deterministic id.
   *
   * This is the exactly-once mechanism for the whole system. The id is a hash of
   * (repo, pr, author, path, line, createdAt), so ingesting the same page twice
   * updates rows instead of adding them, and a worker killed halfway through a
   * page can safely re-walk it. Mutable thread state is refreshed on conflict
   * because a thread can go outdated or resolved after first being seen.
   */
  async upsertComments(repoId: number, items: ReviewComment[], authorLogins: Map<string, string>): Promise<number> {
    if (items.length === 0) return 0;

    const rows = items.map((c) => ({
      id: c.id,
      repoId,
      pr: c.pr,
      reviewer: c.reviewer,
      authorLogin: authorLogins.get(c.id) ?? c.reviewer,
      path: c.path,
      line: c.line,
      severity: c.severity,
      bodyLength: c.bodyLength,
      createdAt: new Date(c.createdAt),
      threadOutdated: c.threadOutdated,
      threadResolved: c.threadResolved,
      prState: c.prState,
    }));

    // Chunked: Postgres caps bind parameters per statement, and a large repo can
    // produce thousands of comments in one page walk.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db
        .insert(comments)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: comments.id,
          set: {
            threadOutdated: sql`excluded.thread_outdated`,
            threadResolved: sql`excluded.thread_resolved`,
            prState: sql`excluded.pr_state`,
            severity: sql`excluded.severity`,
          },
        });
    }
    return rows.length;
  }

  /** Comments for a reviewer inside a window, as engine-shaped records. */
  async commentsInWindow(
    repoId: number,
    reviewer: string,
    from: Date,
    to: Date,
  ): Promise<ReviewComment[]> {
    const rows = await this.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.repoId, repoId),
          eq(comments.reviewer, reviewer),
          gte(comments.createdAt, from),
          lte(comments.createdAt, to),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      repo: '',
      pr: r.pr,
      reviewer: r.reviewer,
      path: r.path,
      line: r.line,
      severity: r.severity as ReviewComment['severity'],
      bodyLength: r.bodyLength,
      createdAt: r.createdAt.toISOString(),
      threadOutdated: r.threadOutdated,
      threadResolved: r.threadResolved,
      prState: r.prState as ReviewComment['prState'],
    }));
  }

  async countComments(repoId: number): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.repoId, repoId));
    return row?.n ?? 0;
  }

  /** Reviewers present on a repo, most active first. */
  async reviewersFor(repoId: number): Promise<Array<{ reviewer: string; comments: number }>> {
    const rows = await this.db
      .select({ reviewer: comments.reviewer, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(eq(comments.repoId, repoId))
      .groupBy(comments.reviewer)
      .orderBy(sql`count(*) desc`);
    return rows.map((r) => ({ reviewer: r.reviewer, comments: r.n }));
  }

  // ── Backfill checkpointing ────────────────────────────────────────────────

  async startBackfill(repoId: number, maxPages: number): Promise<BackfillRow> {
    // Reuse an unfinished run so a re-enqueue resumes rather than restarting.
    const existing = await this.activeBackfill(repoId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(backfills)
      .values({ repoId, maxPages, status: 'running' })
      .returning();
    return row!;
  }

  async activeBackfill(repoId: number): Promise<BackfillRow | undefined> {
    const [row] = await this.db
      .select()
      .from(backfills)
      .where(and(eq(backfills.repoId, repoId), sql`${backfills.status} in ('queued','running')`))
      .orderBy(sql`${backfills.id} desc`)
      .limit(1);
    return row;
  }

  async getBackfill(id: number): Promise<BackfillRow | undefined> {
    const [row] = await this.db.select().from(backfills).where(eq(backfills.id, id)).limit(1);
    return row;
  }

  /**
   * Commit one page of progress. Called after the page's comments are persisted,
   * so a crash between the two leaves the cursor pointing at a page that will be
   * safely re-ingested rather than one that was silently skipped.
   */
  async commitPage(
    id: number,
    patch: { cursor: string | null; prs: number; comments: number },
  ): Promise<void> {
    await this.db
      .update(backfills)
      .set({
        cursor: patch.cursor,
        pagesDone: sql`${backfills.pagesDone} + 1`,
        prsIngested: sql`${backfills.prsIngested} + ${patch.prs}`,
        commentsIngested: sql`${backfills.commentsIngested} + ${patch.comments}`,
        updatedAt: new Date(),
      })
      .where(eq(backfills.id, id));
  }

  async finishBackfill(id: number, status: 'done' | 'failed', error?: string): Promise<void> {
    await this.db
      .update(backfills)
      .set({ status, lastError: error ?? null, updatedAt: new Date() })
      .where(eq(backfills.id, id));
  }

  // ── Scorecards ────────────────────────────────────────────────────────────

  async saveScorecard(repoId: number, card: Scorecard): Promise<void> {
    await this.db
      .insert(scorecards)
      .values({
        repoId,
        reviewer: card.reviewer,
        windowFrom: card.window.from,
        windowTo: card.window.to,
        decided: card.totals.decided,
        actedOn: card.totals.actedOn,
        effectiveness: card.totals.effectiveness,
        payload: card,
      })
      .onConflictDoUpdate({
        target: [scorecards.repoId, scorecards.reviewer, scorecards.windowFrom, scorecards.windowTo],
        set: {
          decided: sql`excluded.decided`,
          actedOn: sql`excluded.acted_on`,
          effectiveness: sql`excluded.effectiveness`,
          payload: sql`excluded.payload`,
          computedAt: new Date(),
        },
      });
  }

  async latestScorecard(repoId: number, reviewer: string): Promise<Scorecard | undefined> {
    const [row] = await this.db
      .select()
      .from(scorecards)
      .where(and(eq(scorecards.repoId, repoId), eq(scorecards.reviewer, reviewer)))
      .orderBy(sql`${scorecards.computedAt} desc`)
      .limit(1);
    return row?.payload as Scorecard | undefined;
  }

  // ── Webhook dedupe & ledger ───────────────────────────────────────────────

  /** True when this delivery is new. A repeat returns false and should no-op. */
  async recordDelivery(deliveryId: string, event: string): Promise<boolean> {
    const inserted = await this.db
      .insert(webhookDeliveries)
      .values({ deliveryId, event })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.deliveryId });
    return inserted.length > 0;
  }

  /**
   * Delete all ingested data for one repo, keeping the repo row.
   *
   * Exists for test isolation (the exactly-once suite asserts absolute counts)
   * and for a genuine "re-ingest this repo from scratch" operation. Kept on the
   * store rather than as raw SQL in a test so nothing bypasses this layer.
   */
  async clearRepoData(repoId: number): Promise<void> {
    await this.db.delete(comments).where(eq(comments.repoId, repoId));
    await this.db.delete(backfills).where(eq(backfills.repoId, repoId));
    await this.db.delete(scorecards).where(eq(scorecards.repoId, repoId));
  }

  async logApiCall(entry: {
    repoId?: number | null;
    kind: string;
    durationMs: number;
    retries?: number;
    rateLimitRemaining?: number | null;
  }): Promise<void> {
    await this.db.insert(apiCalls).values({
      repoId: entry.repoId ?? null,
      kind: entry.kind,
      durationMs: entry.durationMs,
      retries: entry.retries ?? 0,
      rateLimitRemaining: entry.rateLimitRemaining ?? null,
    });
  }
}
