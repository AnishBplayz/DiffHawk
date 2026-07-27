'use server';

import { scoreRepo } from '@diffhawk/core';
import { GitHubClient, GitHubError } from '@diffhawk/github';
import { CENSUS_BASELINE } from '@diffhawk/ingest';
import { EMPTY_STATE, type ScoreState } from './score-state.ts';

const WINDOW_DAYS = 90;
const PR_LIMIT = 120; // covers two windows so the trend has prior data

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

  const client = new GitHubClient({ token });

  let data;
  try {
    data = await client.fetchRepoPulls(owner, name, PR_LIMIT);
  } catch (err) {
    const message =
      err instanceof GitHubError
        ? err.message.includes('not found')
          ? `Could not find a public repository at ${repo}.`
          : err.message
        : 'Something went wrong reading that repository.';
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

  return {
    scorecard,
    otherReviewers: reviewersSeen.map((r) => r.reviewer).filter((r) => r !== scorecard.reviewer),
    error: null,
    repo,
  };
}
