import { test, expect } from 'bun:test';
import { GitHubClient, GitHubError } from './client.ts';

/**
 * These pin the two bugs that made a 120-PR request fail while reporting the
 * wrong reason. Both were found by driving the real UI, not by unit tests, so
 * they get tests now.
 */

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')).variables ?? {});
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** A well-formed page response, already wrapped in the stub's { body } shape. */
const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
  body: {
    data: {
      repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } },
      rateLimit: { remaining: 4999, resetAt: '' },
    },
  },
});

const pull = (number: number) => ({
  number, state: 'MERGED', createdAt: '2026-06-01T00:00:00Z',
  reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] },
});

test('never requests more than 100 in a single page, and paginates instead', async () => {
  const first = Array.from({ length: 100 }, (_, i) => pull(i));
  const second = Array.from({ length: 20 }, (_, i) => pull(100 + i));
  const s = stubFetch([page(first, true, 'CUR1'), page(second, false, null)]);
  try {
    const out = await new GitHubClient({ token: 't' }).fetchRepoPulls('o', 'r', 120);
    expect(out.pulls).toHaveLength(120);
    // GitHub rejects first > 100 outright, so every page must respect the cap.
    for (const c of s.calls) expect(c.prCount as number).toBeLessThanOrEqual(100);
    expect(s.calls[1]!.after).toBe('CUR1');
  } finally {
    s.restore();
  }
});

test('stops early when the repo has fewer pulls than requested', async () => {
  const s = stubFetch([page([pull(1), pull(2)], false, null)]);
  try {
    const out = await new GitHubClient({ token: 't' }).fetchRepoPulls('o', 'r', 500);
    expect(out.pulls).toHaveLength(2);
    expect(s.calls).toHaveLength(1);
  } finally {
    s.restore();
  }
});

test('a GraphQL error alongside data is surfaced, not swallowed', async () => {
  // GitHub answers an invalid argument with HTTP 200, a null field and an error.
  // Reporting "not found" here sent me hunting the wrong bug for a while.
  const s = stubFetch([
    { body: { data: { repository: null }, errors: [{ message: 'first cannot exceed 100' }] } },
  ]);
  try {
    await expect(new GitHubClient({ token: 't' }).fetchRepoPulls('o', 'r', 10)).rejects.toThrow(
      /first cannot exceed 100/,
    );
  } finally {
    s.restore();
  }
});

test('a genuine missing repo still reports as missing', async () => {
  const s = stubFetch([{ body: { data: { repository: null } } }]);
  try {
    await expect(new GitHubClient({ token: 't' }).fetchRepoPulls('o', 'r', 10)).rejects.toThrow(
      GitHubError,
    );
  } finally {
    s.restore();
  }
});
