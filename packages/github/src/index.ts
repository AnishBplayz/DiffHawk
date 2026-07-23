export { GitHubClient, GitHubError, RateLimitError, type GitHubClientOptions } from './client.ts';

import { execFileSync } from 'node:child_process';

/**
 * Resolve a GitHub token without setup friction: an explicit env var first, else
 * whatever `gh` is already logged in as. The census used the same fallback so a
 * developer machine needs no token dance.
 */
export function resolveToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}
