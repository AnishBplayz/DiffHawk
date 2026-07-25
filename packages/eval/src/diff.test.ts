import { test, expect } from 'bun:test';
import { changedRanges, rangesTouchLine } from './diff.ts';

test('extracts added-line ranges in new-file coordinates', () => {
  const patch = [
    '@@ -10,3 +10,4 @@ function f() {',
    ' context',
    '+added line',
    ' more context',
    ' tail',
  ].join('\n');
  const ranges = changedRanges(patch);
  // new-file: line 10 context, 11 added, 12/13 context → change at 11
  expect(ranges).toContainEqual([11, 11]);
});

test('records a deletion at its new-file position', () => {
  const patch = ['@@ -5,3 +5,2 @@', ' keep', '-removed', ' keep2'].join('\n');
  const ranges = changedRanges(patch);
  expect(rangesTouchLine(ranges, 6, 0)).toBe(true);
});

test('handles multiple hunks independently', () => {
  const patch = [
    '@@ -1,2 +1,3 @@', ' a', '+b', ' c',
    '@@ -20,2 +21,3 @@', ' x', '+y', ' z',
  ].join('\n');
  const ranges = changedRanges(patch);
  expect(rangesTouchLine(ranges, 2)).toBe(true);
  expect(rangesTouchLine(ranges, 22)).toBe(true);
  expect(rangesTouchLine(ranges, 40, 0)).toBe(false);
});

test('empty or missing patch yields no ranges', () => {
  expect(changedRanges('')).toEqual([]);
  expect(changedRanges(null)).toEqual([]);
  expect(changedRanges(undefined)).toEqual([]);
});

test('window tolerance around a line', () => {
  const ranges = changedRanges(['@@ -1,1 +1,2 @@', ' a', '+b'].join('\n'));
  expect(rangesTouchLine(ranges, 5, 3)).toBe(true); // 2 within ±3 of 5
  expect(rangesTouchLine(ranges, 5, 1)).toBe(false);
});
