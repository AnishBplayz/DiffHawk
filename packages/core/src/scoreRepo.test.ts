import { test, expect } from 'bun:test';
import { scoreRepo } from './index.ts';
import type { RepoPulls, RawThread } from './ports.ts';

/** Build a review thread with sensible defaults. */
function thread(p: Partial<RawThread> & { path: string }): RawThread {
  return {
    reviewerLogin: 'coderabbitai',
    reviewerIsBot: true,
    line: 1,
    body: 'Potential issue: this can fail.',
    createdAt: '2026-06-01T00:00:00Z',
    isOutdated: false,
    isResolved: false,
    ...p,
  };
}

function repoWith(threads: RawThread[], state: RawPull['state'] = 'MERGED'): RepoPulls {
  return {
    owner: 'acme', name: 'api',
    pulls: [{ number: 1, state, createdAt: '2026-06-01T00:00:00Z', threads }],
    reviewerLoginsSeen: ['coderabbitai'],
  };
}
type RawPull = RepoPulls['pulls'][number];

const WINDOW = { from: '2026-03-01', to: '2026-06-01' };

test('scores effectiveness as the share of comments whose code changed', () => {
  const threads = [
    thread({ path: 'src/a.ts', isOutdated: true }),
    thread({ path: 'src/b.ts', isOutdated: true }),
    thread({ path: 'src/c.ts', isOutdated: false }),
    thread({ path: 'src/d.ts', isOutdated: false }),
  ];
  const { scorecard } = scoreRepo(repoWith(threads), { window: WINDOW });
  expect(scorecard!.totals.comments).toBe(4);
  expect(scorecard!.totals.actedOn).toBe(2);
  expect(scorecard!.totals.effectiveness).toBe(0.5);
});

test('a near-noise reviewer gets the "noise" verdict against its baseline', () => {
  // 20 comments, 1 acted on = 5% — well below CodeRabbit's ~37% global.
  const threads = Array.from({ length: 20 }, (_, i) =>
    thread({ path: `src/f${i}.ts`, isOutdated: i === 0 }),
  );
  const { scorecard } = scoreRepo(repoWith(threads), {
    window: WINDOW,
    baseline: { CodeRabbit: 0.365 },
  });
  expect(scorecard!.baseline!.verdict).toBe('noise');
  expect(scorecard!.flags.some((f) => f.kind === 'bottom_decile')).toBe(true);
});

test('a sharp reviewer is recognised as sharp', () => {
  const threads = Array.from({ length: 10 }, (_, i) =>
    thread({ path: `src/g${i}.ts`, isOutdated: i < 7 }), // 70%
  );
  const { scorecard } = scoreRepo(repoWith(threads), {
    window: WINDOW,
    baseline: { CodeRabbit: 0.365 },
  });
  expect(scorecard!.baseline!.verdict).toBe('sharp');
});

test('junk paths are excluded from the denominator, not scored as noise', () => {
  const threads = [
    thread({ path: 'src/real.ts', isOutdated: true }),
    thread({ path: 'pnpm-lock.yaml' }),
    thread({ path: 'dist/bundle.min.js' }),
    thread({ path: 'api/schema.generated.ts' }),
  ];
  const { scorecard } = scoreRepo(repoWith(threads), { window: WINDOW });
  // Only the real source comment survives; effectiveness is 100%, not 25%.
  expect(scorecard!.totals.comments).toBe(1);
  expect(scorecard!.totals.effectiveness).toBe(1);
});

test('non-AI (human) threads are not counted', () => {
  const threads = [
    thread({ path: 'src/a.ts', reviewerLogin: 'some-human-dev', reviewerIsBot: false, isOutdated: true }),
    thread({ path: 'src/b.ts', isOutdated: true }),
  ];
  const { scorecard, reviewersSeen } = scoreRepo(repoWith(threads), { window: WINDOW });
  expect(scorecard!.totals.comments).toBe(1);
  expect(reviewersSeen).toEqual([{ reviewer: 'CodeRabbit', comments: 1 }]);
});

test('on an open PR, an already-changed thread counts; an untouched one pends', () => {
  const threads = [
    thread({ path: 'src/a.ts', isOutdated: true }), // code already changed → decided
    thread({ path: 'src/b.ts', isOutdated: false }), // still could be addressed → pending
  ];
  const { scorecard } = scoreRepo(repoWith(threads, 'OPEN'), { window: WINDOW });
  expect(scorecard!.totals.decided).toBe(1);
  expect(scorecard!.totals.pending).toBe(1);
  expect(scorecard!.totals.actedOn).toBe(1);
  expect(scorecard!.caveats.some((c) => c.includes('still-open'))).toBe(true);
});

test('mixed open + merged: only decided comments drive the rate', () => {
  const data: RepoPulls = {
    owner: 'acme', name: 'api',
    pulls: [
      { number: 1, state: 'MERGED', createdAt: '2026-06-01T00:00:00Z', threads: [
        thread({ path: 'src/a.ts', isOutdated: true }),
        thread({ path: 'src/b.ts', isOutdated: false }),
      ] },
      { number: 2, state: 'OPEN', createdAt: '2026-06-02T00:00:00Z', threads: [
        thread({ path: 'src/c.ts', isOutdated: false }),
      ] },
    ],
    reviewerLoginsSeen: ['coderabbitai'],
  };
  const { scorecard } = scoreRepo(data, { window: WINDOW });
  expect(scorecard!.totals.comments).toBe(3);
  expect(scorecard!.totals.decided).toBe(2);
  expect(scorecard!.totals.pending).toBe(1);
  expect(scorecard!.totals.effectiveness).toBe(0.5); // 1 of 2 decided, open one ignored
});

test('a repo with no AI reviewer yields no scorecard, cleanly', () => {
  const data: RepoPulls = {
    owner: 'acme', name: 'api',
    pulls: [{ number: 1, state: 'MERGED', createdAt: '2026-06-01T00:00:00Z',
      threads: [thread({ path: 'src/a.ts', reviewerLogin: 'dependabot', reviewerIsBot: true })] }],
    reviewerLoginsSeen: ['dependabot'],
  };
  const { scorecard, reviewersSeen } = scoreRepo(data, { window: WINDOW });
  expect(scorecard).toBeNull();
  expect(reviewersSeen).toEqual([]);
});
