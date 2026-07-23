import type { Bucket, ReviewComment, Scorecard, Severity } from '../schemas.ts';
import { classifyOutcome, isActedOn } from './outcome.ts';
import { areaOf } from './attribute.ts';

export interface ScoreInput {
  repo: string;
  reviewer: string;
  window: { from: string; to: string };
  comments: ReviewComment[];
  /** Global effectiveness for this reviewer, from the census, if known. */
  baselineEffectiveness?: number;
  /** Whether any PR in the sample was still open (drives a caveat). */
  hadOpenPulls: boolean;
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

function bucketize(
  comments: ReviewComment[],
  keyOf: (c: ReviewComment) => string,
): Map<string, { comments: number; actedOn: number }> {
  const out = new Map<string, { comments: number; actedOn: number }>();
  for (const c of comments) {
    const key = keyOf(c);
    const b = out.get(key) ?? { comments: 0, actedOn: 0 };
    b.comments++;
    if (isActedOn(classifyOutcome(c))) b.actedOn++;
    out.set(key, b);
  }
  return out;
}

const toBucket = (key: string, v: { comments: number; actedOn: number }): Bucket => ({
  key,
  comments: v.comments,
  actedOn: v.actedOn,
  effectiveness: v.comments === 0 ? 0 : v.actedOn / v.comments,
});

/**
 * Verdict bands come straight from the census per-repo distribution
 * (p10=13%, median=44%, p90=69%): below p10 is effectively noise, below median
 * is weak, above p90 is sharp. Absolute bands, not relative — a reviewer at 6%
 * is noise regardless of what its global average happens to be.
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
  const { comments } = input;
  const actedOn = comments.filter((c) => isActedOn(classifyOutcome(c))).length;
  const effectiveness = comments.length === 0 ? 0 : actedOn / comments.length;

  const bySeverity: Bucket[] = [...bucketize(comments, (c) => c.severity)]
    .map(([k, v]) => toBucket(k, v))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.key as Severity) - SEVERITY_ORDER.indexOf(b.key as Severity));

  const byArea: Bucket[] = [...bucketize(comments, (c) => areaOf(c.path))]
    .map(([k, v]) => toBucket(k, v))
    .sort((a, b) => b.comments - a.comments);

  const base = input.baselineEffectiveness;
  const baseline: Scorecard['baseline'] =
    base === undefined
      ? null
      : {
          globalEffectiveness: base,
          // Coarse percentile via the global distribution; null keeps us honest
          // about it being an approximation, not a true per-reviewer rank.
          percentile: null,
          verdict: verdictFor(effectiveness),
        };

  const flags: Scorecard['flags'] = [];
  if (base !== undefined && comments.length >= 20 && effectiveness < base * 0.6) {
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

  const caveats = buildCaveats(input, comments.length);

  return {
    repo: input.repo,
    reviewer: input.reviewer,
    window: input.window,
    totals: { comments: comments.length, actedOn, effectiveness },
    baseline,
    bySeverity,
    byArea,
    flags,
    caveats,
  };
}

/**
 * The honesty surface. These travel with every scorecard so no number is read
 * without the biases behind it. The action proxy is a proxy, and saying so is
 * the difference between a measurement tool and a confident guess.
 */
function buildCaveats(input: ScoreInput, n: number): string[] {
  const caveats: string[] = [
    "\"Acted-on\" means the anchored code changed after the comment (GitHub's isOutdated). It is a proxy: an unrelated edit to the same lines also counts, and a correct comment a team declines to fix does not.",
  ];
  if (input.hadOpenPulls) {
    caveats.push(
      'Some pulls are still open; their comments have no decided outcome yet and are counted as not-yet-acted-on, which understates a very recent window.',
    );
  }
  if (n < 30) {
    caveats.push(`Only ${n} comments in this window — too few for a stable rate. Treat as directional.`);
  }
  return caveats;
}
