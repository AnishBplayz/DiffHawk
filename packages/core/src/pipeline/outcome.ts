import type { ReviewComment, Outcome } from '../schemas.ts';

/**
 * OUTCOME — resolve what became of each comment. No LLM, no heuristics on text:
 * pure git/GraphQL signals, so every verdict is auditable back to a fact GitHub
 * itself recorded.
 *
 * Precedence matters. A thread can be both outdated and resolved; "the code
 * changed" is the stronger, less ambiguous signal, so it wins. An open PR has no
 * decided outcome yet and is reported as such rather than counted as ignored —
 * counting not-yet-decided as failure would understate every active repo.
 */
export function classifyOutcome(c: ReviewComment): Outcome {
  if (c.threadOutdated) {
    return { commentId: c.id, kind: 'acted_on', evidence: 'thread_outdated' };
  }
  if (c.threadResolved) {
    // Resolved-without-a-code-change: a human engaged and closed it. Counted
    // separately from acted_on because "acknowledged" is not "acted on".
    return { commentId: c.id, kind: 'resolved', evidence: 'thread_resolved' };
  }
  if (!c.prClosed) {
    return { commentId: c.id, kind: 'ignored', evidence: 'pr_open' };
  }
  return { commentId: c.id, kind: 'ignored', evidence: 'pr_closed_unchanged' };
}

/**
 * Whether an outcome counts as the reviewer having *worked* — i.e. its comment
 * led to a change in the code. Resolved-without-change deliberately does not
 * count: the whole product exists to separate "acted on" from "acknowledged".
 */
export function isActedOn(o: Outcome): boolean {
  return o.kind === 'acted_on';
}
