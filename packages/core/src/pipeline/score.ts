import type { Bucket, Outcome, ReviewComment, Scorecard, Severity } from '../schemas.ts';
import { classifyOutcome, isActedOn, isDecided } from './outcome.ts';
import { areaOf } from './attribute.ts';

export interface ScoreInput {
  repo: string;
  reviewer: string;
  window: { from: string; to: string };
  comments: ReviewComment[];
  /** Global effectiveness for this reviewer, from the census, if known. */
  baselineEffectiveness?: number;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

/** A comment paired with its computed outcome, so we classify exactly once. */
interface Scored {
  comment: ReviewComment;
  outcome: Outcome;
}

/**
 * Bucket decided comments by a key. Pending comments are excluded entirely — a
 * bucket's rate must be actedOn / decided, never diluted by undecided ones.
 */
function bucketize(scored: Scored[], keyOf: (c: ReviewComment) => string): Bucket[] {
  const acc = new Map<string, { comments: number; actedOn: number }>();
  for (const { comment, outcome } of scored) {
    if (!isDecided(outcome)) continue;
    const key = keyOf(comment);
    const b = acc.get(key) ?? { comments: 0, actedOn: 0 };
    b.comments++;
    if (isActedOn(outcome)) b.actedOn++;
    acc.set(key, b);
  }
  return [...acc].map(([key, v]) => ({
    key,
    comments: v.comments,
    actedOn: v.actedOn,
    effectiveness: v.comments === 0 ? 0 : v.actedOn / v.comments,
  }));
}

/**
 * Verdict bands come straight from the census per-repo distribution
 * (p10≈14%, median≈43%, p90≈70%): below ~p10 is effectively noise, below median
 * is weak, near p90 is sharp. Absolute bands, not relative — a reviewer at 6% is
 * noise regardless of what its global average happens to be.
 */
function verdictFor(eff: number): 'sharp' | 'typical' | 'weak' | 'noise' {
  if (eff < 0.15) return 'noise';
  if (eff < 0.3) return 'weak';
  if (eff >= 0.6) return 'sharp';
  return 'typical';
}

/**
 * SCORE — turn classified comments into the scorecard. The headline is not the
 * raw rate but where it sits versus the census baseline for this reviewer.
 */
export function score(input: ScoreInput): Scorecard {
  const scored: Scored[] = input.comments.map((comment) => ({
    comment,
    outcome: classifyOutcome(comment),
  }));

  const decidedItems = scored.filter((s) => isDecided(s.outcome));
  const pending = scored.length - decidedItems.length;
  const actedOn = decidedItems.filter((s) => isActedOn(s.outcome)).length;
  const effectiveness = decidedItems.length === 0 ? 0 : actedOn / decidedItems.length;

  const bySeverity = bucketize(scored, (c) => c.severity).sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.key as Severity) - SEVERITY_ORDER.indexOf(b.key as Severity),
  );
  const byArea = bucketize(scored, (c) => areaOf(c.path)).sort((a, b) => b.comments - a.comments);

  const base = input.baselineEffectiveness;
  const baseline: Scorecard['baseline'] =
    base === undefined
      ? null
      : {
          globalEffectiveness: base,
          // Coarse: null keeps us honest that this is not a true per-reviewer rank.
          percentile: null,
          verdict: verdictFor(effectiveness),
        };

  const flags: Scorecard['flags'] = [];
  if (base !== undefined && decidedItems.length >= 20 && effectiveness < base * 0.6) {
    flags.push({
      kind: 'bottom_decile',
      detail: `${(effectiveness * 100).toFixed(0)}% acted-on vs ${(base * 100).toFixed(0)}% global for ${input.reviewer} — well below par.`,
    });
  }
  const lowValueBulk = bySeverity.find(
    (b) => (b.key === 'low' || b.key === 'unknown') && b.comments >= 15 && b.effectiveness < 0.1,
  );
  if (lowValueBulk) {
    flags.push({
      kind: 'high_volume_low_value',
      detail: `${lowValueBulk.comments} ${lowValueBulk.key}-severity comments at ${(lowValueBulk.effectiveness * 100).toFixed(0)}% acted-on — high volume, little value.`,
    });
  }

  return {
    repo: input.repo,
    reviewer: input.reviewer,
    window: input.window,
    totals: {
      comments: scored.length,
      decided: decidedItems.length,
      pending,
      actedOn,
      effectiveness,
    },
    baseline,
    bySeverity,
    byArea,
    flags,
    caveats: buildCaveats(scored, pending),
  };
}

/**
 * The honesty surface. These travel with every scorecard so no number is read
 * without the biases behind it. Each caveat is only emitted when it actually
 * applies to this scorecard — a static disclaimer nobody reads is worse than a
 * specific one that names the effect and its direction.
 */
function buildCaveats(scored: Scored[], pending: number): string[] {
  const caveats: string[] = [
    "\"Acted-on\" = the anchored code changed after the comment (GitHub's isOutdated). It is a proxy for influence, not proof: a rebase or an unrelated edit to the same lines also marks a thread outdated (inflates), and a fix made elsewhere in the file does not (deflates).",
  ];

  if (pending > 0) {
    caveats.push(
      `${pending} comment(s) on still-open PRs are excluded from the rate as undecided, not counted as failures.`,
    );
  }

  const decided = scored.filter((s) => isDecided(s.outcome));
  const abandoned = decided.filter((s) => s.outcome.evidence === 'pr_abandoned').length;
  if (decided.length > 0 && abandoned / decided.length > 0.25) {
    caveats.push(
      `${abandoned} of ${decided.length} scored comments are on PRs closed without merging; their code never shipped, so "acted-on" here means the author responded, not that the change landed.`,
    );
  }

  const actedFromUnmerged = decided.filter(
    (s) => isActedOn(s.outcome) && s.comment.prState === 'closed_unmerged',
  ).length;
  const actedTotal = decided.filter((s) => isActedOn(s.outcome)).length;
  if (actedTotal > 0 && actedFromUnmerged / actedTotal > 0.2) {
    caveats.push(
      `${actedFromUnmerged} of ${actedTotal} acted-on comments come from PRs that never merged — the influence is real but the code is not in main.`,
    );
  }

  if (decided.length < 30) {
    caveats.push(`Only ${decided.length} decided comments — too few for a stable rate. Treat as directional.`);
  }

  return caveats;
}
