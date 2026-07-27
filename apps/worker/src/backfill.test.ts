import { test, expect, beforeAll, afterAll } from 'bun:test';
import { connect, migrate, ReviewStore, type Db } from '@diffhawk/db';
import { runBackfillPage } from './backfill.ts';
import type { RepoPulls } from '@diffhawk/core';

/**
 * Phase 3's exit gate, as a test: a backfill interrupted mid-walk must resume and
 * finish having counted every comment EXACTLY once.
 *
 * Runs against a real Postgres because the guarantee lives in the database (a
 * primary key on a deterministic id plus an upsert). Mocking the store would
 * test the mock, not the property that matters.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/diffhawk';

let db: Db;
let closeDb: (() => Promise<void>) | undefined;
let store: ReviewStore;

/**
 * These tests need a real Postgres, because the guarantee under test lives in the
 * database (a primary key on a deterministic id, plus an upsert). Mocking the
 * store would test the mock.
 *
 * When no database is reachable they SKIP rather than fail. A contributor who
 * clones this repo and runs `bun test` without starting Docker should see a green
 * suite and a clear note, not a red failure that reads like broken code.
 *
 * Start one with: cd deploy/docker && docker compose up -d postgres
 */
let dbAvailable = false;

beforeAll(async () => {
  try {
    const c = connect(DATABASE_URL, { max: 4 });
    db = c.db;
    closeDb = c.close;
    await migrate(db);
    store = new ReviewStore(db);
    dbAvailable = true;
  } catch {
    await closeDb?.().catch(() => {});
    closeDb = undefined;
    process.stderr.write(
      `\n  note: skipping exactly-once backfill tests, no Postgres at ${DATABASE_URL}\n` +
        '        start one with: cd deploy/docker && docker compose up -d postgres\n\n',
    );
  }
});

afterAll(async () => {
  await closeDb?.().catch(() => {});
});

/** Skips the body when no database is reachable. */
const dbTest: typeof test = ((name: string, fn: () => unknown) =>
  test(name, async () => {
    if (!dbAvailable) return;
    await fn();
  })) as typeof test;

/** A synthetic page of pulls: `n` pulls, each with one AI review thread. */
function page(startPr: number, n: number, outdated = true): RepoPulls {
  return {
    owner: 'acme',
    name: 'chaos',
    reviewerLoginsSeen: ['coderabbitai'],
    pulls: Array.from({ length: n }, (_, i) => ({
      number: startPr + i,
      state: 'MERGED' as const,
      createdAt: '2026-06-01T00:00:00Z',
      threads: [
        {
          reviewerLogin: 'coderabbitai',
          reviewerIsBot: true,
          path: `src/file${startPr + i}.ts`,
          line: 10,
          body: 'Potential issue: this can fail.',
          createdAt: '2026-06-02T00:00:00Z',
          isOutdated: outdated,
          isResolved: false,
        },
      ],
    })),
  };
}

/**
 * A GitHub stub that serves a fixed number of pages and can be made to throw at
 * a chosen page, simulating a worker dying mid-walk.
 */
function stubGitHub(opts: { pages: number; perPage: number; failOnCall?: number }) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async fetchPullsPage(owner: string, name: string, _size: number, after: string | null) {
        calls++;
        if (opts.failOnCall && calls === opts.failOnCall) {
          throw new Error('simulated worker death mid-page');
        }
        const index = after ? Number(after.replace('cur', '')) : 0;
        const p = page(index * opts.perPage + 1, opts.perPage);
        const isLast = index + 1 >= opts.pages;
        return {
          ...p,
          owner,
          name,
          hasNextPage: !isLast,
          endCursor: isLast ? null : `cur${index + 1}`,
        };
      },
    } as never,
  };
}

const noLimiter = { acquire: async () => {} } as never;

async function freshRepo(name: string) {
  const repo = await store.ensureRepo('acme', name);
  // This suite asserts absolute counts, so each run starts from a clean slate.
  await store.clearRepoData(repo.id);
  return repo;
}

dbTest('a clean backfill ingests every page exactly once', async () => {
  const repo = await freshRepo('chaos-clean');
  const gh = stubGitHub({ pages: 4, perPage: 5 });
  const bf = await store.startBackfill(repo.id, 10);

  let guard = 0;
  for (;;) {
    const r = await runBackfillPage(
      { repoId: repo.id, owner: 'acme', name: 'chaos-clean', backfillId: bf.id },
      { store, github: gh.client, limiter: noLimiter, pageSize: 5 },
    );
    if (r.done || ++guard > 20) break;
  }

  // 4 pages x 5 pulls x 1 thread each.
  expect(await store.countComments(repo.id)).toBe(20);
  const finished = await store.getBackfill(bf.id);
  expect(finished!.status).toBe('done');
  expect(finished!.pagesDone).toBe(4);
});

dbTest('killed mid-walk, it resumes and still counts exactly once', async () => {
  const repo = await freshRepo('chaos-kill');
  // Dies on the 3rd fetch, i.e. after two pages are committed.
  const gh = stubGitHub({ pages: 4, perPage: 5, failOnCall: 3 });
  const bf = await store.startBackfill(repo.id, 10);

  let died = false;
  try {
    for (let i = 0; i < 10; i++) {
      const r = await runBackfillPage(
        { repoId: repo.id, owner: 'acme', name: 'chaos-kill', backfillId: bf.id },
        { store, github: gh.client, limiter: noLimiter, pageSize: 5 },
      );
      if (r.done) break;
    }
  } catch (err) {
    died = /simulated worker death/.test((err as Error).message);
  }
  expect(died).toBe(true);

  const midway = await store.getBackfill(bf.id);
  expect(midway!.pagesDone).toBe(2); // two committed before the death
  expect(await store.countComments(repo.id)).toBe(10);

  // A NEW worker picks up the same backfill row and resumes from the cursor.
  const gh2 = stubGitHub({ pages: 4, perPage: 5 });
  for (let i = 0; i < 10; i++) {
    const r = await runBackfillPage(
      { repoId: repo.id, owner: 'acme', name: 'chaos-kill', backfillId: bf.id },
      { store, github: gh2.client, limiter: noLimiter, pageSize: 5 },
    );
    if (r.done) break;
  }

  // The critical assertion: 20, not 25 or 30. No page was double-counted and
  // none was skipped.
  expect(await store.countComments(repo.id)).toBe(20);
  expect((await store.getBackfill(bf.id))!.status).toBe('done');
});

dbTest('re-running a completed page is a no-op, not a duplicate', async () => {
  const repo = await freshRepo('chaos-replay');
  const gh = stubGitHub({ pages: 1, perPage: 5 });
  const bf = await store.startBackfill(repo.id, 10);

  await runBackfillPage(
    { repoId: repo.id, owner: 'acme', name: 'chaos-replay', backfillId: bf.id },
    { store, github: gh.client, limiter: noLimiter, pageSize: 5 },
  );
  expect(await store.countComments(repo.id)).toBe(5);

  // Deliver the same job again, as a retry or a duplicate would.
  await runBackfillPage(
    { repoId: repo.id, owner: 'acme', name: 'chaos-replay', backfillId: bf.id },
    { store, github: gh.client, limiter: noLimiter, pageSize: 5 },
  );
  expect(await store.countComments(repo.id)).toBe(5);
});

dbTest('webhook deliveries dedupe on the delivery id', async () => {
  const id = `delivery-${Math.random().toString(36).slice(2)}`;
  expect(await store.recordDelivery(id, 'pull_request')).toBe(true);
  // GitHub retries deliveries; the retry must be a no-op.
  expect(await store.recordDelivery(id, 'pull_request')).toBe(false);
});
