import { test, expect } from 'bun:test';
import { classifyOutcome, isActedOn } from './outcome.ts';
import type { ReviewComment } from '../schemas.ts';

const base: ReviewComment = {
  id: 'x', repo: 'o/r', pr: 1, reviewer: 'CodeRabbit', path: 'src/a.ts', line: 10,
  severity: 'high', bodyLength: 20, createdAt: '2026-01-01T00:00:00Z',
  threadOutdated: false, threadResolved: false, prClosed: true,
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

test('open PR is not-yet-decided, not a failure', () => {
  const o = classifyOutcome({ ...base, prClosed: false });
  expect(o.kind).toBe('ignored');
  expect(o.evidence).toBe('pr_open');
});

test('closed PR with no signal is ignored', () => {
  const o = classifyOutcome(base);
  expect(o.kind).toBe('ignored');
  expect(o.evidence).toBe('pr_closed_unchanged');
});
