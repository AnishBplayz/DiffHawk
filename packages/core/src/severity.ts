import type { Severity } from './schemas.ts';

/**
 * Infer a comment's severity from its opening text — cheaply, with no LLM.
 *
 * The census showed the signal separates by severity, not by path, so this is
 * the axis that matters. Most reviewers self-label with a recognisable prefix
 * (an emoji, a bracketed tag, a lead word), which is enough for a coarse bucket.
 *
 * This is a heuristic and is reported as one: everything unmatched is `unknown`
 * rather than being force-fit into a level, so the `unknown` bucket's size is an
 * honest measure of how often we couldn't tell.
 */

const RULES: Array<{ level: Severity; test: RegExp }> = [
  // Order matters: critical/high before the softer buckets.
  { level: 'critical', test: /\b(critical|security|vulnerab|CVE|injection|exploit|data loss|severe)\b/i },
  { level: 'critical', test: /🚨|⛔|🔴/u },
  { level: 'high', test: /\b(bug|potential issue|error|broken|incorrect|will fail|race condition|null pointer|crash)\b/i },
  { level: 'high', test: /⚠️|❗|🛑/u },
  // "consider" is deliberately absent — too ambiguous ("consider refactoring"
  // reads medium, "consider renaming" reads low), so it's left to stronger signals.
  { level: 'low', test: /\b(nit|nitpick|typo|style|formatting|optional|minor|readability)\b/i },
  { level: 'low', test: /📝|💅|🔧|🛠️|ℹ️/u },
  { level: 'medium', test: /\b(suggestion|refactor|improve|warning|recommend|maintainab|performance)\b/i },
];

export function classifySeverity(body: string): Severity {
  const head = body.slice(0, 240);
  for (const { level, test } of RULES) {
    if (test.test(head)) return level;
  }
  return 'unknown';
}
