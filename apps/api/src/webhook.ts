import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub's `X-Hub-Signature-256` over the RAW request body.
 *
 * Two details that are easy to get wrong and both security-relevant:
 *
 * 1. The HMAC must be computed over the exact bytes GitHub sent. Re-serialising
 *    a parsed JSON body changes key order and whitespace, so the digest never
 *    matches and the usual "fix" is to disable verification.
 * 2. The comparison must be timing-safe. A plain `===` leaks how many leading
 *    bytes were correct, which is enough to forge a signature byte by byte.
 */
export function verifySignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself an early exit,
  // so the lengths are compared first and deliberately.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface PullRequestEvent {
  action?: string;
  repository?: { owner?: { login?: string }; name?: string };
  pull_request?: { number?: number };
}

/** Extract the repo coordinates a webhook refers to, if it names one. */
export function repoFromEvent(payload: unknown): { owner: string; name: string } | null {
  const p = payload as PullRequestEvent;
  const owner = p?.repository?.owner?.login;
  const name = p?.repository?.name;
  return owner && name ? { owner, name } : null;
}

/** Events worth acting on. Anything else is acknowledged and ignored. */
export const ACTIONABLE_EVENTS = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);
