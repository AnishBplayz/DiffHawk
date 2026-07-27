/**
 * @diffhawk/core — the pure measurement engine.
 *
 * No I/O, no framework, no clock of its own. Raw review data in (via the ports),
 * a validated Scorecard out. Everything here is deterministic and unit-testable
 * against a fixture, which is the whole point of keeping it pure.
 */

import { identifyBot } from '@diffhawk/ingest';
import { ReviewComment, type Scorecard } from './schemas.ts';
import type { RepoPulls, RawThread } from './ports.ts';
import { classifySeverity } from './severity.ts';
import { DEFAULT_IGNORE_GLOBS } from './pipeline/attribute.ts';
import { score, windowEffectiveness } from './pipeline/score.ts';
import pm from 'picomatch';

export * from './schemas.ts';
export * from './ports.ts';
export { classifyOutcome, isActedOn } from './pipeline/outcome.ts';
export { classifySeverity } from './severity.ts';
export { areaOf, DEFAULT_IGNORE_GLOBS } from './pipeline/attribute.ts';
export { score, windowEffectiveness, type ScoreInput } from './pipeline/score.ts';
export { renderScorecard } from './pipeline/render.ts';
export { renderScorecardMarkdown, SCORECARD_MARKER } from './pipeline/markdown.ts';

/** Deterministic id for a comment, so re-scans dedupe instead of double-count. */
function commentId(repo: string, pr: number, t: RawThread): string {
  const raw = `${repo}#${pr}|${t.reviewerLogin ?? '?'}|${t.path}|${t.line ?? '?'}|${t.createdAt}`;
  // djb2 — a stable, dependency-free hash. Collisions are irrelevant here; we
  // only need the same input to map to the same id across runs.
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface ScoreRepoOptions {
  /** Only score this reviewer; default scores whichever AI reviewer is dominant. */
  reviewer?: string;
  /** Census baseline lookup by canonical vendor name. */
  baseline?: Record<string, number>;
  ignoreGlobs?: string[];
  window: { from: string; to: string };
  /**
   * Also compare against the equal-length window immediately before `window`,
   * to detect degradation. Comments from that earlier span must be present in
   * `data` (fetch enough PRs to cover both), else the trend is simply null.
   */
  detectTrend?: boolean;
  /** Drop in percentage points that trips a degradation flag (default 15). */
  degradationDropPts?: number;
}

export interface ScoreRepoResult {
  scorecard: Scorecard | null;
  /** Every AI reviewer seen, with its comment count — for "no data" messaging. */
  reviewersSeen: Array<{ reviewer: string; comments: number }>;
}

/**
 * Turn a provider's raw pulls into a scorecard for one reviewer.
 *
 * Reviewer resolution happens here, not at fetch time, so extending the bot
 * registry reclassifies existing raw data for free — the same design that let
 * the census fix its numbers without re-scanning.
 */
export function scoreRepo(data: RepoPulls, opts: ScoreRepoOptions): ScoreRepoResult {
  const repo = `${data.owner}/${data.name}`;
  const isIgnored = pm(opts.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS);

  const comments: ReviewComment[] = [];
  const seen = new Map<string, number>();

  for (const pull of data.pulls) {
    const prState =
      pull.state === 'OPEN' ? 'open' : pull.state === 'MERGED' ? 'merged' : 'closed_unmerged';

    for (const t of pull.threads) {
      const bot = identifyBot(t.reviewerLogin);
      if (bot?.category !== 'ai-review') continue;
      seen.set(bot.vendor, (seen.get(bot.vendor) ?? 0) + 1);
      if (isIgnored(t.path)) continue;

      comments.push(
        ReviewComment.parse({
          id: commentId(repo, pull.number, t),
          repo,
          pr: pull.number,
          reviewer: bot.vendor,
          path: t.path,
          line: t.line,
          severity: classifySeverity(t.body),
          bodyLength: t.body.length,
          createdAt: t.createdAt,
          threadOutdated: t.isOutdated,
          threadResolved: t.isResolved,
          prState,
        }),
      );
    }
  }

  const reviewersSeen = [...seen.entries()]
    .map(([reviewer, c]) => ({ reviewer, comments: c }))
    .sort((a, b) => b.comments - a.comments);

  // Default to the reviewer with the most comments if none was named.
  const target = opts.reviewer ?? reviewersSeen[0]?.reviewer;
  if (!target) return { scorecard: null, reviewersSeen };

  const forReviewer = comments.filter((c) => c.reviewer === target);
  if (forReviewer.length === 0) return { scorecard: null, reviewersSeen };

  // Partition by the window's dates. Until now the window was only a label;
  // scoring the whole fetch conflated "last 90 days" with "the last 60 PRs".
  const inWindow = forReviewer.filter(
    (c) => c.createdAt >= opts.window.from && c.createdAt <= `${opts.window.to}T23:59:59Z`,
  );

  let previous: { effectiveness: number; decided: number } | undefined;
  if (opts.detectTrend) {
    const spanMs = Date.parse(`${opts.window.to}T23:59:59Z`) - Date.parse(opts.window.from);
    const prevFrom = new Date(Date.parse(opts.window.from) - spanMs).toISOString();
    const prevComments = forReviewer.filter(
      (c) => c.createdAt >= prevFrom && c.createdAt < opts.window.from,
    );
    if (prevComments.length > 0) previous = windowEffectiveness(prevComments);
  }

  const scorecard = score({
    repo,
    reviewer: target,
    window: opts.window,
    comments: inWindow,
    baselineEffectiveness: opts.baseline?.[target],
    previous,
    degradationDropPts: opts.degradationDropPts,
  });

  return { scorecard, reviewersSeen };
}

export { commentId };
