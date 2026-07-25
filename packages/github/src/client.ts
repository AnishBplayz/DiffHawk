import type { VcsProvider, RepoPulls, RawPull, RawThread } from '@diffhawk/core';

/**
 * GitHub adapter — read-only GraphQL over fetch, no Octokit.
 *
 * A fetch client is deliberate: the Phase-0 CLI only reads public review
 * threads, and the whole dependency footprint of Octokit buys nothing here.
 * (Octokit arrives in App mode for webhook signature verification, where
 * hand-rolling crypto would be the wrong call.)
 *
 * The retry and rate-limit handling is ported from the census, which ran this
 * path across 800+ repositories: GitHub answers secondary limits with 403 +
 * Retry-After rather than 429, and serves occasional 502s on large queries.
 */

const ENDPOINT = 'https://api.github.com/graphql';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubError extends Error {}
export class RateLimitError extends GitHubError {}

const PULLS_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $prCount: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: [MERGED, CLOSED, OPEN], first: $prCount, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          state
          createdAt
          reviewThreads(first: 50) {
            nodes {
              isOutdated
              isResolved
              path
              line
              originalLine
              comments(first: 1) {
                nodes { author { login __typename } createdAt body }
              }
            }
          }
          reviews(first: 20) { nodes { author { login __typename } } }
          comments(first: 20) { nodes { author { login __typename } } }
        }
      }
    }
    rateLimit { remaining resetAt }
  }
`;

interface Author { login: string; __typename: string }
interface GqlThread {
  isOutdated: boolean; isResolved: boolean; path: string;
  line: number | null; originalLine: number | null;
  comments: { nodes: Array<{ author: Author | null; createdAt: string; body: string }> };
}
interface GqlPull {
  number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; createdAt: string;
  reviewThreads: { nodes: GqlThread[] };
  reviews: { nodes: Array<{ author: Author | null }> };
  comments: { nodes: Array<{ author: Author | null }> };
}

export interface GitHubClientOptions {
  token: string;
  onLog?: (msg: string) => void;
}

export class GitHubClient implements VcsProvider {
  #token: string;
  #log: (msg: string) => void;

  constructor(opts: GitHubClientOptions) {
    this.#token = opts.token;
    this.#log = opts.onLog ?? (() => {});
  }

  async fetchRepoPulls(owner: string, name: string, prLimit: number): Promise<RepoPulls> {
    const data = await this.#graphql<{ repository: { pullRequests: { nodes: GqlPull[] } } | null }>(
      PULLS_QUERY,
      { owner, name, prCount: prLimit },
    );

    if (!data.repository) {
      throw new GitHubError(`Repository ${owner}/${name} not found or not accessible.`);
    }

    const reviewerLoginsSeen = new Set<string>();
    const pulls: RawPull[] = data.repository.pullRequests.nodes.map((pr) => {
      for (const r of pr.reviews.nodes) if (r.author?.login) reviewerLoginsSeen.add(r.author.login);
      for (const cm of pr.comments.nodes) if (cm.author?.login) reviewerLoginsSeen.add(cm.author.login);

      const threads: RawThread[] = pr.reviewThreads.nodes.map((t) => {
        const opener = t.comments.nodes[0];
        const login = opener?.author?.login ?? null;
        if (login) reviewerLoginsSeen.add(login);
        return {
          reviewerLogin: login,
          reviewerIsBot: opener?.author?.__typename === 'Bot',
          path: t.path,
          line: t.line ?? t.originalLine,
          body: (opener?.body ?? '').slice(0, 500),
          createdAt: opener?.createdAt ?? pr.createdAt,
          isOutdated: Boolean(t.isOutdated),
          isResolved: Boolean(t.isResolved),
        };
      });

      return { number: pr.number, state: pr.state, createdAt: pr.createdAt, threads };
    });

    return { owner, name, pulls, reviewerLoginsSeen: [...reviewerLoginsSeen] };
  }

  /**
   * Commits on a pull request, with dates — used by the eval harness to build a
   * ground truth independent of `isOutdated`. REST, because the per-commit file
   * patch (below) is only exposed there.
   */
  async listPullCommits(owner: string, name: string, pr: number): Promise<Array<{ sha: string; date: string }>> {
    const out: Array<{ sha: string; date: string }> = [];
    for (let page = 1; page <= 3; page++) {
      const rows = await this.#rest<Array<{ sha: string; commit: { committer?: { date?: string }; author?: { date?: string } } }>>(
        `/repos/${owner}/${name}/pulls/${pr}/commits?per_page=100&page=${page}`,
      );
      for (const r of rows) out.push({ sha: r.sha, date: r.commit.committer?.date ?? r.commit.author?.date ?? '' });
      if (rows.length < 100) break;
    }
    return out;
  }

  /**
   * The set of changed files in one commit, each mapped to the patch text, so
   * the caller can compute which new-file line ranges the commit touched.
   */
  async getCommitPatches(owner: string, name: string, sha: string): Promise<Map<string, string>> {
    const data = await this.#rest<{ files?: Array<{ filename: string; patch?: string }> }>(
      `/repos/${owner}/${name}/commits/${sha}`,
    );
    const out = new Map<string, string>();
    for (const f of data.files ?? []) if (f.patch) out.set(f.filename, f.patch);
    return out;
  }

  async #rest<T>(path: string, attempt = 0): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `bearer ${this.#token}`,
        'User-Agent': 'diffhawk',
        Accept: 'application/vnd.github+json',
      },
    });
    if (res.status === 401) throw new GitHubError('GitHub rejected the token (401).');
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 30);
      if (attempt >= 4) throw new RateLimitError(`Rate limited after ${attempt} retries.`);
      this.#log(`  rate limited, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.#rest<T>(path, attempt + 1);
    }
    if (res.status >= 500) {
      if (attempt >= 4) throw new GitHubError(`GitHub ${res.status} after ${attempt} retries.`);
      await sleep(Math.min(2 ** attempt * 1000, 16000));
      return this.#rest<T>(path, attempt + 1);
    }
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`);
    return (await res.json()) as T;
  }

  async #graphql<T>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${this.#token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'diffhawk',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) throw new GitHubError('GitHub rejected the token (401). Check GITHUB_TOKEN.');

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 30);
      if (attempt >= 4) throw new RateLimitError(`Rate limited after ${attempt} retries.`);
      this.#log(`  rate limited, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.#graphql<T>(query, variables, attempt + 1);
    }
    if (res.status >= 500) {
      if (attempt >= 4) throw new GitHubError(`GitHub ${res.status} after ${attempt} retries.`);
      await sleep(Math.min(2 ** attempt * 1000, 16000));
      return this.#graphql<T>(query, variables, attempt + 1);
    }
    if (!res.ok) throw new GitHubError(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string; type?: string }> };
    if (json.errors?.length && !json.data) {
      throw new GitHubError(`GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new GitHubError('GraphQL returned no data.');
    return json.data;
  }
}
