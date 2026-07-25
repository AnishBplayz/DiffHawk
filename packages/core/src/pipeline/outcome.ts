import type { ReviewComment, Outcome } from '../schemas.ts';

/**
 * OUTCOME — resolve what became of each comment. No LLM, no heuristics on text:
 * pure git/GraphQL signals, so every verdict is auditable back to a fact GitHub
 * itself recorded.
 *
 * Precedence matters. A thread can be both outdated and resolved; "the code
 * changed" is the stronger, less ambiguous signal, so it wins. A comment on an
 * OPEN pull request has no decided outcome yet and is `pending` — excluded from
 * the rate, never counted as failure. A comment on a pull request that was
 * closed WITHOUT merging is `ignored` with distinct `pr_abandoned` evidence,
 * because the code never shipped regardless of intent.
 */
export function classifyOutcome(c: ReviewComment): Outcome {
  const id = c.id;

  // Open PR: undecided. Excluded from scoring so a fresh window isn't punished.
  if (c.prState === 'open') {
    return { commentId: id, kind: 'pending', evidence: 'pr_open' };
  }

  if (c.threadOutdated) {
    // The anchored code changed after the comment. Our action proxy. This fires
    // for merged and closed-unmerged alike — the reviewer influenced a change;
    // whether it shipped is a separate dimension surfaced in caveats.
    return { commentId: id, kind: 'acted_on', evidence: 'thread_outdated' };
  }

  if (c.threadResolved) {
    // Resolved without a code change: a human engaged and closed it. Counted
    // separately from acted_on because "acknowledged" is not "acted on".
    return { commentId: id, kind: 'resolved', evidence: 'thread_resolved' };
  }

  // Nothing changed. Distinguish "merged, comment untouched" from "PR abandoned"
  // so a repo that simply closes stale PRs isn't read the same as one that
  // merges over its reviewer's objections.
  return c.prState === 'merged'
    ? { commentId: id, kind: 'ignored', evidence: 'pr_merged_unchanged' }
    : { commentId: id, kind: 'ignored', evidence: 'pr_abandoned' };
}

/**
 * Whether an outcome counts as the reviewer having *worked* — its comment led to
 * a change in the code. Resolved-without-change deliberately does not count.
 */
export function isActedOn(o: Outcome): boolean {
  return o.kind === 'acted_on';
}

/**
 * Whether an outcome has been decided at all. `pending` comments (open PRs) are
 * excluded from the effectiveness denominator — including them would understate
 * every actively-developed repo, which is a bias, not a measurement.
 */
export function isDecided(o: Outcome): boolean {
  return o.kind !== 'pending';
}
