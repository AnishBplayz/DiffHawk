#!/usr/bin/env bun
/**
 * DiffHawk worker.
 *
 * Consumes backfill and scoring jobs. Kept deliberately separate from the API so
 * the two scale independently: the API is latency-bound (a webhook must answer
 * inside GitHub's 10 second timeout) while the worker is rate-limit bound.
 */

import { Worker, Queue } from 'bullmq';
import { scoreRepo } from '@diffhawk/core';
import { CENSUS_BASELINE } from '@diffhawk/ingest';
import { GitHubClient, resolveToken } from '@diffhawk/github';
import { connect, migrate, ReviewStore } from '@diffhawk/db';
import { SharedRateLimiter } from './limiter.ts';
import { runBackfillPage, type BackfillPageJob } from './backfill.ts';
import {
  QUEUE_BACKFILL,
  QUEUE_SCORE,
  connectionFor,
  redisConnection,
  makeQueues,
  toDeadLetter,
  DEFAULT_JOB_OPTS,
} from './queues.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/diffhawk';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);

const log = (msg: string, meta: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ level: 'info', msg, ...meta, at: new Date().toISOString() }) + '\n');
const logErr = (msg: string, meta: Record<string, unknown> = {}) =>
  process.stderr.write(JSON.stringify({ level: 'error', msg, ...meta, at: new Date().toISOString() }) + '\n');

async function main(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    logErr('no GitHub token; set GITHUB_TOKEN');
    process.exit(1);
  }

  const { db, close: closeDb } = connect(DATABASE_URL);
  await migrate(db);
  const store = new ReviewStore(db);

  const limiterRedis = redisConnection(REDIS_URL);
  const limiter = new SharedRateLimiter(limiterRedis);
  const github = new GitHubClient({ token });
  const queues = makeQueues(REDIS_URL);
  const connection = connectionFor(REDIS_URL);

  /**
   * Backfill: one job per page. On success the job re-enqueues itself for the
   * next page rather than looping in-process, so progress survives a restart and
   * one huge repository cannot monopolise a worker slot.
   */
  const backfillWorker = new Worker<BackfillPageJob>(
    QUEUE_BACKFILL,
    async (job) => {
      const result = await runBackfillPage(job.data, { store, github, limiter, log });
      if (!result.done) {
        await queues.backfill.add('page', job.data, DEFAULT_JOB_OPTS);
      } else {
        // Backfill finished: score it.
        await queues.score.add('score', { repoId: job.data.repoId, owner: job.data.owner, name: job.data.name });
      }
      return result;
    },
    { connection, concurrency: CONCURRENCY },
  );

  const scoreWorker = new Worker(
    QUEUE_SCORE,
    async (job) => {
      const { repoId, owner, name } = job.data as { repoId: number; owner: string; name: string };
      const reviewers = await store.reviewersFor(repoId);
      const to = new Date();
      const from = new Date(to.getTime() - 90 * 864e5);

      for (const { reviewer } of reviewers) {
        const comments = await store.commentsInWindow(repoId, reviewer, from, to);
        if (comments.length === 0) continue;
        const { score } = await import('@diffhawk/core');
        const card = score({
          repo: `${owner}/${name}`,
          reviewer,
          window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
          comments,
          baselineEffectiveness: CENSUS_BASELINE[reviewer],
        });
        await store.saveScorecard(repoId, card);
        log('scorecard saved', { repo: `${owner}/${name}`, reviewer, effectiveness: card.totals.effectiveness });
      }
      return { reviewers: reviewers.length };
    },
    { connection, concurrency: 2 },
  );

  // A job that has exhausted its attempts is recorded, not dropped.
  for (const [name, w] of [
    [QUEUE_BACKFILL, backfillWorker],
    [QUEUE_SCORE, scoreWorker],
  ] as const) {
    w.on('failed', async (job, err) => {
      logErr('job failed', { queue: name, id: job?.id, attempts: job?.attemptsMade, error: err.message });
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        await toDeadLetter(queues.dlq, {
          queue: name,
          jobName: job.name,
          data: job.data,
          error: err.message,
          attemptsMade: job.attemptsMade,
        });
        logErr('moved to dead letter queue', { queue: name, id: job.id });
      }
    });
  }

  log('worker ready', { concurrency: CONCURRENCY, queues: [QUEUE_BACKFILL, QUEUE_SCORE] });

  /**
   * Graceful shutdown. `close()` stops accepting new jobs and waits for in-flight
   * ones, so a rolling deploy does not orphan a page mid-ingest. Even if it did,
   * the checkpoint ordering makes the resumed page safe.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down', { signal });
    await Promise.allSettled([backfillWorker.close(), scoreWorker.close()]);
    await queues.close();
    await limiterRedis.quit().catch(() => {});
    await closeDb();
    log('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logErr('worker crashed', { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});

export { Queue };
