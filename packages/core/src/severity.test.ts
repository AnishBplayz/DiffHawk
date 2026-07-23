import { test, expect } from 'bun:test';
import { classifySeverity } from './severity.ts';

test('classifies common reviewer phrasings', () => {
  expect(classifySeverity('🚨 Critical: SQL injection risk here')).toBe('critical');
  expect(classifySeverity('Potential issue: this will fail when x is null')).toBe('high');
  expect(classifySeverity('⚠️ possible race condition')).toBe('high');
  expect(classifySeverity('Nitpick: rename this variable for readability')).toBe('low');
  expect(classifySeverity('📝 minor style suggestion')).toBe('low');
  expect(classifySeverity('Suggestion: consider refactoring for maintainability')).toBe('medium');
});

test('unmatched text is unknown, never force-fit', () => {
  expect(classifySeverity('The quick brown fox.')).toBe('unknown');
  expect(classifySeverity('')).toBe('unknown');
});

test('critical beats lower signals when both present', () => {
  // A body mentioning both "security" and "nit" resolves to the higher level.
  expect(classifySeverity('security: nit about the error message wording')).toBe('critical');
});
