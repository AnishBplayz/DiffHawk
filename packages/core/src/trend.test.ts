import { test, expect } from 'bun:test';
import { scoreRepo, renderScorecardMarkdown, SCORECARD_MARKER } from './index.ts';
import type { RepoPulls, RawThread } from './ports.ts';

/**
 * Trend/degradation is computed by partitioning comments into the current window
 * and the equal-length window before it. These fixtures place comments by date
 * across those two spans.
 */

const NOW = new Date('2026-07-01T00:00:00Z');
const WINDOW = { from: '2026-04-02', to: '2026-07-01' }; // ~90 days
// previous window: ~2026-01-02 .. 2026-04-02

function thread(p: Partial<RawThread> & { path: string; createdAt: string }): RawThread {
  return {
    reviewerLogin: 'coderabbitai', reviewerIsBot: true, line: 1,
    body: 'Potential issue.', isOutdated: false, isResolved: false, ...p,
  };
}

/** N threads in a date, a fraction of them acted-on. */
function threads(date: string, n: number, actedFraction: number): RawThread[] {
  return Array.from({ length: n }, (_, i) =>
    thread({ path: `src/f${date}-${i}.ts`, createdAt: date, isOutdated: i < Math.round(n * actedFraction) }),
  );
}

function repo(all: RawThread[]): RepoPulls {
  return {
    owner: 'acme', name: 'api',
    pulls: [{ number: 1, state: 'MERGED', createdAt: '2026-01-01T00:00:00Z', threads: all }],
    reviewerLoginsSeen: ['coderabbitai'],
  };
}

test('detects degradation when effectiveness drops between windows', () => {
  const data = repo([
    ...threads('2026-02-01T00:00:00Z', 30, 0.6), // previous window: 60%
    ...threads('2026-05-01T00:00:00Z', 30, 0.2), // current window: 20%
  ]);
  const { scorecard } = scoreRepo(data, { window: WINDOW, detectTrend: true });
  expect(scorecard!.trend).not.toBeNull();
  expect(scorecard!.trend!.deltaPts).toBeLessThan(-30);
  expect(scorecard!.flags.some((f) => f.kind === 'degraded')).toBe(true);
});

test('stable effectiveness raises no degradation flag', () => {
  const data = repo([
    ...threads('2026-02-01T00:00:00Z', 30, 0.5),
    ...threads('2026-05-01T00:00:00Z', 30, 0.5),
  ]);
  const { scorecard } = scoreRepo(data, { window: WINDOW, detectTrend: true });
  expect(scorecard!.flags.some((f) => f.kind === 'degraded')).toBe(false);
});

test('trend is null without enough prior data (no false alarms)', () => {
  const data = repo([
    ...threads('2026-02-01T00:00:00Z', 5, 0.6), // too few in previous window
    ...threads('2026-05-01T00:00:00Z', 30, 0.2),
  ]);
  const { scorecard } = scoreRepo(data, { window: WINDOW, detectTrend: true });
  expect(scorecard!.trend).toBeNull();
  expect(scorecard!.flags.some((f) => f.kind === 'degraded')).toBe(false);
});

test('window filtering excludes comments outside the current window', () => {
  const data = repo([
    ...threads('2026-05-01T00:00:00Z', 10, 0.5), // in window
    ...threads('2025-01-01T00:00:00Z', 40, 1.0), // long before either window
  ]);
  const { scorecard } = scoreRepo(data, { window: WINDOW, detectTrend: false });
  expect(scorecard!.totals.comments).toBe(10); // the old 40 are excluded
});

test('no decided comments yields "insufficient", never a fabricated verdict', () => {
  // Every PR still open: 0 decided. Calling this "noise" would be the tool
  // inventing a judgement from nothing.
  const data: RepoPulls = {
    owner: 'acme', name: 'api',
    pulls: [{ number: 1, state: 'OPEN', createdAt: '2026-05-01T00:00:00Z',
      threads: threads('2026-05-01T00:00:00Z', 40, 0.0) }],
    reviewerLoginsSeen: ['coderabbitai'],
  };
  const { scorecard } = scoreRepo(data, { window: WINDOW, baseline: { CodeRabbit: 0.37 } });
  expect(scorecard!.totals.decided).toBe(0);
  expect(scorecard!.baseline!.verdict).toBe('insufficient');

  const md = renderScorecardMarkdown(scorecard!);
  expect(md).toContain('No decided comments yet');
  expect(md).not.toContain('below* average'); // no comparison off zero data
});

test('a thin but non-zero sample still withholds a verdict', () => {
  const data = repo(threads('2026-05-01T00:00:00Z', 6, 0.0));
  const { scorecard } = scoreRepo(data, { window: WINDOW, baseline: { CodeRabbit: 0.37 } });
  expect(scorecard!.totals.decided).toBe(6);
  expect(scorecard!.baseline!.verdict).toBe('insufficient'); // < 10 decided
});

test('markdown scorecard carries the idempotency marker and headline', () => {
  const data = repo(threads('2026-05-01T00:00:00Z', 20, 0.5));
  const { scorecard } = scoreRepo(data, { window: WINDOW, baseline: { CodeRabbit: 0.37 } });
  const md = renderScorecardMarkdown(scorecard!);
  expect(md).toContain(SCORECARD_MARKER);
  expect(md).toContain('DiffHawk');
  expect(md).toContain('50%');
});
