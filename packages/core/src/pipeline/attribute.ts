/**
 * ATTRIBUTE — assign a comment to the buckets the scorecard reports on.
 *
 * Severity is the axis the census proved matters. Area is a coarse path grouping
 * kept for drill-down only — explicitly NOT a suppression axis, because the
 * census showed noise is not path-separable (generated/lock/migration paths are
 * 0.8% of comments and reviewers already skip them). See ADR-008.
 */

/**
 * Coarse area from a file path: the first two segments, so `src/api/users.ts`
 * and `src/api/auth.ts` share an `src/api` bucket. Files at the root, or with a
 * single segment, bucket under that segment or `/`.
 */
export function areaOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Paths excluded from measurement entirely — not "suppressed", just not
 * meaningful signal. Lockfiles and generated output rarely carry human-actionable
 * review comments, and including them would dilute the denominator. Kept
 * deliberately short; the census showed these are <1% of comments anyway.
 */
export const DEFAULT_IGNORE_GLOBS = [
  '**/*.generated.*',
  '**/*_generated.*',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.min.*',
  '**/*.map',
  '**/*.snap',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/node_modules/**',
  '**/*.lock',
  '**/*-lock.json',
  '**/*-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];
