import { test, expect } from 'bun:test';
import { classifyOutcome, isActedOn, isDecided } from './outcome.ts';
import type { ReviewComment } from '../schemas.ts';

const base: ReviewComment = {
  id: 'x', repo: 'o/r', pr: 1, reviewer: 'CodeRabbit', path: 'src/a.ts', line: 10,
  severity: 'high', bodyLength: 20, createdAt: '2026-01-01T00:00:00Z',
  threadOutdated: false, threadResolved: false, prState: 'merged',
};

test('code-changed wins over everything and counts as acted-on', () => {
  const o = classifyOutcome({ ...base, threadOutdated: true, threadResolved: true });
  expect(o.kind).toBe('acted_on');
  expect(o.evidence).toBe('thread_outdated');
  expect(isActedOn(o)).toBe(true);
});

test('resolved-without-change is acknowledged, not acted-on', () => {
  const o = classifyOutcome({ ...base, threadResolved: true });
  expect(o.kind).toBe('resolved');
  expect(isActedOn(o)).toBe(false);
});

test('open PR with untouched code is pending — excluded, not a failure', () => {
  const o = classifyOutcome({ ...base, prState: 'open' });
  expect(o.kind).toBe('pending');
  expect(o.evidence).toBe('pr_open');
  expect(isDecided(o)).toBe(false);
});

test('open PR whose code already changed counts as acted-on', () => {
  // The change is an observed fact; a later merge cannot undo it. Calling this
  // "pending" threw away decided successes on active repos.
  const o = classifyOutcome({ ...base, prState: 'open', threadOutdated: true });
  expect(o.kind).toBe('acted_on');
  expect(isDecided(o)).toBe(true);
  expect(isActedOn(o)).toBe(true);
});

test('merged PR, no change: ignored with merged-unchanged evidence', () => {
  const o = classifyOutcome(base);
  expect(o.kind).toBe('ignored');
  expect(o.evidence).toBe('pr_merged_unchanged');
});

test('abandoned PR (closed unmerged), no change: distinct evidence', () => {
  const o = classifyOutcome({ ...base, prState: 'closed_unmerged' });
  expect(o.kind).toBe('ignored');
  expect(o.evidence).toBe('pr_abandoned');
});
