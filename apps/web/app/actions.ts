'use server';

import { scoreRepo } from '@diffhawk/core';
import { GitHubClient, GitHubError } from '@diffhawk/github';
import { CENSUS_BASELINE } from '@diffhawk/ingest';
import { EMPTY_STATE, type ScoreState } from './score-state.ts';
import { readCache, writeCache, ageMinutes } from './cache.ts';

const WINDOW_DAYS = 90;
/**
 * Lower than the CLI's 120 on purpose.
 *
 * Measured cost is ~64 GraphQL points at 120 pulls against a 5,000/hour budget,
 * i.e. about 78 scorings per hour before the shared demo token is exhausted. One
 * page of 50 keeps a single request cheap; the trade is that trend detection
 * needs two windows of history and often will not have it here, so the scorecard
 * simply omits the trend rather than inventing one.
 */
const PR_LIMIT = 50;

/** Accepts `owner/repo`, a full GitHub URL, or a `.git` suffix. */
function parseSlug(input: string): { owner: string; name: string } | null {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts;
  if (!/^[\w.-]+$/.test(owner!) || !/^[\w.-]+$/.test(name!)) return null;
  return { owner: owner!, name: name! };
}

export async function scoreRepoAction(_prev: ScoreState, formData: FormData): Promise<ScoreState> {
  const raw = String(formData.get('repo') ?? '');
  const parsed = parseSlug(raw);
  if (!parsed) {
    return { ...EMPTY_STATE, error: 'Enter a repository as owner/repo, for example vercel/next.js.' };
  }
  const { owner, name } = parsed;
  const repo = `${owner}/${name}`;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ...EMPTY_STATE,
      repo,
      error: 'This deployment has no GITHUB_TOKEN configured, so it cannot read pull requests.',
    };
  }

  // Serve a recent result rather than spending budget on a repeat lookup.
  const cached = readCache(owner, name);
  if (cached) {
    return {
      scorecard: cached.scorecard,
      otherReviewers: cached.otherReviewers,
      error: null,
      repo,
      cachedMinutesAgo: ageMinutes(cached.at),
    };
  }

  const client = new GitHubClient({ token });

  let data;
  try {
    data = await client.fetchRepoPulls(owner, name, PR_LIMIT);
  } catch (err) {
    let message = 'Something went wrong reading that repository.';
    if (err instanceof GitHubError) {
      if (/not found/i.test(err.message)) {
        message = `Could not find a public repository at ${repo}.`;
      } else if (/rate limit/i.test(err.message)) {
        // Say what actually happened. "Something went wrong" would leave people
        // thinking the tool is broken when it is only out of budget.
        message =
          'This shared demo has used up its hourly GitHub quota. Try again shortly, or run it locally against your own token: bun run score ' +
          repo;
      } else {
        message = err.message;
      }
    }
    return { ...EMPTY_STATE, repo, error: message };
  }

  const to = new Date();
  const from = new Date(to.getTime() - WINDOW_DAYS * 864e5);
  const { scorecard, reviewersSeen } = scoreRepo(data, {
    baseline: CENSUS_BASELINE,
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    detectTrend: true,
  });

  if (!scorecard) {
    return {
      ...EMPTY_STATE,
      repo,
      error:
        reviewersSeen.length > 0
          ? `Found ${reviewersSeen.map((r) => r.reviewer).join(', ')} on ${repo}, but no inline review comments to score yet.`
          : `No AI code reviewer is commenting on ${repo}. About 63 percent of active repositories run none.`,
    };
  }

  const otherReviewers = reviewersSeen
    .map((r) => r.reviewer)
    .filter((r) => r !== scorecard.reviewer);

  writeCache(owner, name, { scorecard, otherReviewers });
  return { scorecard, otherReviewers, error: null, repo, cachedMinutesAgo: null };
}
