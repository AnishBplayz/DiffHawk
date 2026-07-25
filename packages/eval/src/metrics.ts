import { classifyOutcome, isActedOn, type ReviewComment } from '@diffhawk/core';
import type { LabelledThread } from './groundtruth.ts';

/**
 * Score the cheap `isOutdated`-based classifier against the independent,
 * commit-derived ground truth. The headline is agreement (accuracy); the value
 * is the *shape* of the disagreement, because that is what becomes a documented
 * caveat and, later, a correction.
 */

export interface EvalMetrics {
  n: number;
  agreement: number; // accuracy: share where classifier == gold
  precision: number; // of classifier's acted_on, share truly acted_on
  recall: number; // of truly acted_on, share the classifier caught
  f1: number;
  /**
   * Agreement on the reliable subset (exactly one post-comment commit, so the
   * comment line and the commit patch share a coordinate space). This is the
   * number to trust: on the full set, cross-commit line drift makes the gold
   * itself noisy, so lower "agreement" there partly measures the yardstick's
   * error, not the classifier's.
   */
  reliable: { n: number; agreement: number };
  confusion: { tp: number; fp: number; fn: number; tn: number };
  /**
   * Systematic disagreements, the honesty payload:
   * - inflation: classifier says acted_on, gold says not (rebase / unrelated edit)
   * - deflation: gold says acted_on, classifier missed it (fix elsewhere, no flag)
   */
  inflation: { count: number; share: number; examples: DisagreementExample[] };
  deflation: { count: number; share: number; examples: DisagreementExample[] };
  cappedShare: number;
}

export interface DisagreementExample {
  repo: string;
  pr: number;
  path: string;
  line: number;
  prState: string;
}

/** Build the ReviewComment the classifier would see for a labelled thread. */
function asComment(t: LabelledThread): ReviewComment {
  return {
    id: `${t.repo}#${t.pr}:${t.path}:${t.line}`,
    repo: t.repo,
    pr: t.pr,
    reviewer: t.reviewer,
    path: t.path,
    line: t.line,
    severity: 'unknown',
    bodyLength: 0,
    createdAt: t.createdAt,
    threadOutdated: t.isOutdated,
    threadResolved: t.isResolved,
    prState: t.prState,
  };
}

export function evaluate(labelled: LabelledThread[]): EvalMetrics {
  // Ground truth is only defined for closed/merged PRs (open ones are pending
  // and were never labelled), so every row here is decided on both sides.
  const rows = labelled;
  const ex = (t: LabelledThread): DisagreementExample => ({
    repo: t.repo, pr: t.pr, path: t.path, line: t.line, prState: t.prState,
  });

  let tp = 0, fp = 0, fn = 0, tn = 0;
  const inflation: DisagreementExample[] = [];
  const deflation: DisagreementExample[] = [];

  for (const t of rows) {
    const predActed = isActedOn(classifyOutcome(asComment(t)));
    const goldActed = t.gold === 'acted_on';
    if (predActed && goldActed) tp++;
    else if (predActed && !goldActed) { fp++; inflation.push(ex(t)); }
    else if (!predActed && goldActed) { fn++; deflation.push(ex(t)); }
    else tn++;
  }

  const n = rows.length;
  const agreement = n === 0 ? 0 : (tp + tn) / n;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // Reliable subset: one post-comment commit → no cross-commit line drift.
  const reliableRows = rows.filter((t) => t.postCommits === 1);
  const reliableAgree = reliableRows.filter(
    (t) => isActedOn(classifyOutcome(asComment(t))) === (t.gold === 'acted_on'),
  ).length;

  return {
    n,
    agreement,
    precision,
    recall,
    f1,
    reliable: {
      n: reliableRows.length,
      agreement: reliableRows.length === 0 ? 0 : reliableAgree / reliableRows.length,
    },
    confusion: { tp, fp, fn, tn },
    inflation: { count: fp, share: n === 0 ? 0 : fp / n, examples: inflation.slice(0, 8) },
    deflation: { count: fn, share: n === 0 ? 0 : fn / n, examples: deflation.slice(0, 8) },
    cappedShare: n === 0 ? 0 : rows.filter((t) => t.capped).length / n,
  };
}

/** Human-readable metrics block for the terminal and EVAL.md. */
export function formatMetrics(m: EvalMetrics): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const dimNote = (s: string) => `(${s})`;
  const L: string[] = [];
  L.push(`  threads evaluated   : ${m.n}`);
  L.push(`  agreement (all)     : ${pct(m.agreement)}   ${dimNote('gold is noisy here — see reliable subset')}`);
  L.push(`  agreement (reliable): ${pct(m.reliable.agreement)}   (n=${m.reliable.n}, one post-comment commit, no line drift)`);
  L.push(`  precision / recall  : ${pct(m.precision)} / ${pct(m.recall)}   (F1 ${pct(m.f1)})`);
  L.push(`  confusion           : tp=${m.confusion.tp} fp=${m.confusion.fp} fn=${m.confusion.fn} tn=${m.confusion.tn}`);
  L.push('');
  L.push(`  inflation (isOutdated=acted, commits disagree): ${m.inflation.count} (${pct(m.inflation.share)})`);
  L.push(`  deflation (commits acted, isOutdated missed)  : ${m.deflation.count} (${pct(m.deflation.share)})`);
  if (m.cappedShare > 0) L.push(`  capped PRs (gold may be partial)              : ${pct(m.cappedShare)}`);
  return L.join('\n');
}
