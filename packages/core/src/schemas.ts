import { z } from 'zod';

/**
 * The contract between pipeline stages. Everything crossing a stage boundary is
 * one of these shapes, Zod-validated, so a malformed record is a loud failure at
 * the boundary rather than a wrong number three stages later.
 *
 * A wrong number in a *measurement* product is not a cosmetic bug — it is the
 * product lying. That is why validation lives here and not in comments.
 */

export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
export type Severity = z.infer<typeof Severity>;

/** One review comment left by an AI reviewer, normalised from GitHub's shapes. */
export const ReviewComment = z.object({
  /** Stable id: hash(repo, pr, author, path, line, createdAt). Dedupe key. */
  id: z.string(),
  repo: z.string(),
  pr: z.number().int(),
  /** Canonical vendor name, resolved from the author login at analysis time. */
  reviewer: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  severity: Severity,
  bodyLength: z.number().int(),
  createdAt: z.string(),
  /** GitHub review-thread signals, carried so OUTCOME needs no second fetch. */
  threadOutdated: z.boolean(),
  threadResolved: z.boolean(),
  /** PR lifecycle state, so an open PR reads as pending, not as a failure. */
  prState: z.enum(['open', 'merged', 'closed_unmerged']),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/**
 * What became of a comment. `kind` is the headline; `evidence` records the git
 * fact behind it, so every number in a scorecard is auditable back to a
 * verifiable signal rather than a heuristic nobody can re-check.
 *
 * `pending` is distinct from `ignored`: a comment on an open PR has no decided
 * outcome yet. Counting it as a failure deflated the score of every active repo
 * in Phase 0 — Phase 1 excludes pending from the effectiveness denominator
 * instead of merely caveating it.
 */
export const OutcomeKind = z.enum(['acted_on', 'resolved', 'dismissed', 'ignored', 'pending']);
export type OutcomeKind = z.infer<typeof OutcomeKind>;

export const Outcome = z.object({
  commentId: z.string(),
  kind: OutcomeKind,
  evidence: z.enum([
    'thread_outdated', // the anchored code changed after the comment
    'thread_resolved', // a human explicitly resolved the thread
    'pr_open', // PR still open — outcome not yet decided (pending)
    'pr_merged_unchanged', // PR merged and the code was never touched
    'pr_abandoned', // PR closed unmerged with no change — the code never shipped
  ]),
});
export type Outcome = z.infer<typeof Outcome>;

const Bucket = z.object({
  key: z.string(),
  comments: z.number().int(),
  actedOn: z.number().int(),
  /** actedOn / comments, 0..1. */
  effectiveness: z.number(),
});
export type Bucket = z.infer<typeof Bucket>;

/**
 * The deliverable. Per repo, per reviewer, over a window. The headline is not the
 * raw rate but where it sits against the census baseline for the same reviewer —
 * "18% here vs 44% globally" is the sentence that lands.
 */
export const Scorecard = z.object({
  repo: z.string(),
  reviewer: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  totals: z.object({
    /** Every AI comment seen in the window, decided or not. */
    comments: z.number().int(),
    /** Comments with a decided outcome — the effectiveness denominator. */
    decided: z.number().int(),
    /** Comments on still-open PRs, excluded from the rate. */
    pending: z.number().int(),
    actedOn: z.number().int(),
    /** actedOn / decided. Undefined-safe: 0 when nothing is decided yet. */
    effectiveness: z.number(),
  }),
  /** Census-relative context, when a baseline is available. */
  baseline: z
    .object({
      globalEffectiveness: z.number(),
      /** Rough percentile of this repo among repos running this reviewer. */
      percentile: z.number().nullable(),
      verdict: z.enum(['sharp', 'typical', 'weak', 'noise']),
    })
    .nullable(),
  bySeverity: z.array(Bucket),
  byArea: z.array(Bucket),
  flags: z.array(
    z.object({
      kind: z.enum(['bottom_decile', 'high_volume_low_value']),
      detail: z.string(),
    }),
  ),
  /**
   * The honesty surface. The action proxy's known biases travel *with* the
   * scorecard, not buried in a doc, so nobody reads a number without its caveats.
   */
  caveats: z.array(z.string()),
});
export type Scorecard = z.infer<typeof Scorecard>;
