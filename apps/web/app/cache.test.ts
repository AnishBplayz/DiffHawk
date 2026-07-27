import { test, expect } from 'bun:test';
import { readCache, writeCache, ageMinutes } from './cache.ts';
import type { Scorecard } from '@diffhawk/core';

/**
 * The cache is the only thing standing between a launch spike and an exhausted
 * GitHub quota (measured: ~64 points per scoring against 5,000/hour, so roughly
 * 78 cold lookups before the demo starts erroring). Worth testing rather than
 * assuming.
 */

const card = (reviewer: string) =>
  ({
    repo: 'o/r',
    reviewer,
    window: { from: '2026-01-01', to: '2026-04-01' },
    totals: { comments: 10, decided: 10, pending: 0, actedOn: 5, effectiveness: 0.5 },
    baseline: null,
    bySeverity: [],
    byArea: [],
    trend: null,
    flags: [],
    caveats: [],
  }) as Scorecard;

test('a written entry is readable back', () => {
  writeCache('Acme', 'Widgets', { scorecard: card('CodeRabbit'), otherReviewers: [] });
  const hit = readCache('Acme', 'Widgets');
  expect(hit?.scorecard.reviewer).toBe('CodeRabbit');
});

test('lookups are case-insensitive, so ACME/Widgets is one cache entry', () => {
  writeCache('Acme', 'Widgets', { scorecard: card('Copilot'), otherReviewers: [] });
  // GitHub treats owner/name case-insensitively; caching them separately would
  // silently double the quota cost of the same repository.
  expect(readCache('acme', 'widgets')?.scorecard.reviewer).toBe('Copilot');
  expect(readCache('ACME', 'WIDGETS')?.scorecard.reviewer).toBe('Copilot');
});

test('a miss returns null rather than throwing', () => {
  expect(readCache('nobody', 'nothing')).toBeNull();
});

test('other reviewers survive the round trip', () => {
  writeCache('o', 'r2', { scorecard: card('Gemini'), otherReviewers: ['Copilot', 'Cursor'] });
  expect(readCache('o', 'r2')?.otherReviewers).toEqual(['Copilot', 'Cursor']);
});

test('eviction keeps the cache bounded, and keeps the most recent entry', () => {
  // MAX_ENTRIES is 200; write well past it.
  for (let i = 0; i < 260; i++) {
    writeCache('bulk', `repo${i}`, { scorecard: card('CodeRabbit'), otherReviewers: [] });
  }
  // The newest is retained and an early one has been evicted, so memory cannot
  // grow without bound on a long-running instance.
  expect(readCache('bulk', 'repo259')).not.toBeNull();
  expect(readCache('bulk', 'repo0')).toBeNull();
});

test('ageMinutes reports whole minutes and never goes negative', () => {
  expect(ageMinutes(Date.now())).toBe(0);
  expect(ageMinutes(Date.now() - 5 * 60_000)).toBe(5);
  // A clock skew that puts the entry in the future must not render as "-3 min".
  expect(ageMinutes(Date.now() + 60_000)).toBe(0);
});
