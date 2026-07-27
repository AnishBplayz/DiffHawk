import { extractComments } from '@diffhawk/core';
import type { GitHubClient } from '@diffhawk/github';
import type { ReviewStore } from '@diffhawk/db';
import type { SharedRateLimiter } from './limiter.ts';

/**
 * One page of a repository's review history, ingested and checkpointed.
 *
 * The whole design exists to make a killed worker harmless:
 *
 *   1. fetch one page, bounded by the cursor stored in Postgres
 *   2. persist its comments with an upsert on a deterministic id
 *   3. only then commit the new cursor
 *
 * A crash between 2 and 3 leaves the cursor pointing at a page that gets
 * re-ingested, which the upsert makes a no-op. A crash between 1 and 2 loses
 * nothing but a request. No ordering of failures double-counts a comment or
 * silently skips one, which is what exactly-once means here in practice.
 */

export interface BackfillPageJob {
  repoId: number;
  owner: string;
  name: string;
  backfillId: number;
}

export interface BackfillDeps {
  store: ReviewStore;
  github: GitHubClient;
  limiter: SharedRateLimiter;
  /** Pull requests per page; GitHub caps a connection at 100. */
  pageSize?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface PageResult {
  prs: number;
  comments: number;
  cursor: string | null;
  done: boolean;
  pagesDone: number;
}

export async function runBackfillPage(job: BackfillPageJob, deps: BackfillDeps): Promise<PageResult> {
  const { store, github, limiter } = deps;
  const log = deps.log ?? (() => {});
  const pageSize = Math.min(deps.pageSize ?? 50, 100);

  const state = await store.getBackfill(job.backfillId);
  if (!state) throw new Error(`backfill ${job.backfillId} not found`);

  // Terminal or capped: report done rather than fetching again. Makes a
  // duplicate job delivery harmless.
  if (state.status === 'done' || state.status === 'failed') {
    return { prs: 0, comments: 0, cursor: state.cursor, done: true, pagesDone: state.pagesDone };
  }
  if (state.pagesDone >= state.maxPages) {
    await store.finishBackfill(job.backfillId, 'done');
    log('backfill hit page cap', { repo: `${job.owner}/${job.name}`, pages: state.pagesDone });
    return { prs: 0, comments: 0, cursor: state.cursor, done: true, pagesDone: state.pagesDone };
  }

  // Every outbound GitHub call passes the fleet-wide bucket first, so adding
  // worker replicas raises throughput only up to the shared budget.
  await limiter.acquire();

  const started = Date.now();
  const page = await github.fetchPullsPage(job.owner, job.name, pageSize, state.cursor ?? null);
  await store.logApiCall({
    repoId: job.repoId,
    kind: 'graphql.pullsPage',
    durationMs: Date.now() - started,
  });

  // Same normalisation (and therefore the same ids) the scorer uses.
  const { comments, authorLogins } = extractComments({
    owner: job.owner,
    name: job.name,
    pulls: page.pulls,
    reviewerLoginsSeen: page.reviewerLoginsSeen,
  });

  const written = await store.upsertComments(job.repoId, comments, authorLogins);

  // Cursor is committed LAST. See the ordering note above.
  await store.commitPage(job.backfillId, {
    cursor: page.endCursor,
    prs: page.pulls.length,
    comments: written,
  });

  const pagesDone = state.pagesDone + 1;
  const done = !page.hasNextPage || !page.endCursor || pagesDone >= state.maxPages;
  if (done) await store.finishBackfill(job.backfillId, 'done');

  log('page ingested', {
    repo: `${job.owner}/${job.name}`,
    page: pagesDone,
    prs: page.pulls.length,
    comments: written,
    done,
  });

  return { prs: page.pulls.length, comments: written, cursor: page.endCursor, done, pagesDone };
}
