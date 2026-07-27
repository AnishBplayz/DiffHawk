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

/**
 * GitHub caps every connection's `first:` at 100, so more than one page of pull
 * requests means real pagination. This is not a theoretical limit: a 120 here
 * returns `repository: null` with an error, which previously surfaced as a
 * misleading "repository not found".
 */
const MAX_PAGE = 100;

const PULLS_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $prCount: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        states: [MERGED, CLOSED, OPEN]
        first: $prCount
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
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

interface PullsResponse {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlPull[];
    };
  } | null;
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
    // Walk pages until we have prLimit pulls or GitHub runs out.
    const raw: GqlPull[] = [];
    let cursor: string | null = null;
    while (raw.length < prLimit) {
      const want = Math.min(MAX_PAGE, prLimit - raw.length);
      const data: PullsResponse = await this.#graphql<PullsResponse>(PULLS_QUERY, {
        owner,
        name,
        prCount: want,
        after: cursor,
      });

      if (!data.repository) {
        throw new GitHubError(`Repository ${owner}/${name} not found or not accessible.`);
      }
      const connection = data.repository.pullRequests;
      raw.push(...connection.nodes.filter(Boolean));
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
      cursor = connection.pageInfo.endCursor;
    }

    const { pulls, reviewerLoginsSeen } = this.#mapPulls(raw);
    return { owner, name, pulls, reviewerLoginsSeen };
  }

  /** Shared GraphQL-to-engine mapping, used by both the walk and the page fetch. */
  #mapPulls(raw: GqlPull[]): { pulls: RawPull[]; reviewerLoginsSeen: string[] } {
    const seen = new Set<string>();
    const pulls: RawPull[] = raw.map((pr) => {
      for (const r of pr.reviews.nodes) if (r.author?.login) seen.add(r.author.login);
      for (const cm of pr.comments.nodes) if (cm.author?.login) seen.add(cm.author.login);

      const threads: RawThread[] = pr.reviewThreads.nodes.map((t) => {
        const opener = t.comments.nodes[0];
        const login = opener?.author?.login ?? null;
        if (login) seen.add(login);
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
    return { pulls, reviewerLoginsSeen: [...seen] };
  }

  /**
   * Fetch exactly ONE page of pull requests and return its cursor.
   *
   * The backfill worker needs page-level granularity so it can checkpoint after
   * each page; `fetchRepoPulls` walks all pages internally, which would make a
   * killed worker restart from the beginning.
   */
  async fetchPullsPage(
    owner: string,
    name: string,
    pageSize: number,
    after: string | null,
  ): Promise<RepoPulls & { hasNextPage: boolean; endCursor: string | null }> {
    const data: PullsResponse = await this.#graphql<PullsResponse>(PULLS_QUERY, {
      owner,
      name,
      prCount: Math.min(pageSize, MAX_PAGE),
      after,
    });
    if (!data.repository) {
      throw new GitHubError(`Repository ${owner}/${name} not found or not accessible.`);
    }
    const conn = data.repository.pullRequests;
    const { pulls, reviewerLoginsSeen } = this.#mapPulls(conn.nodes.filter(Boolean));
    return {
      owner,
      name,
      pulls,
      reviewerLoginsSeen,
      hasNextPage: conn.pageInfo.hasNextPage,
      endCursor: conn.pageInfo.endCursor,
    };
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

  // ── Write surface (Action-only; local CLI uses a read-only token) ──────────

  /** Comments on an issue or PR (same endpoint — a PR is an issue). */
  async listComments(owner: string, name: string, number: number): Promise<Array<{ id: number; body: string }>> {
    return this.#rest(`/repos/${owner}/${name}/issues/${number}/comments?per_page=100`);
  }

  async createComment(owner: string, name: string, number: number, body: string): Promise<{ id: number }> {
    return this.#rest(`/repos/${owner}/${name}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }

  async updateComment(owner: string, name: string, commentId: number, body: string): Promise<{ id: number }> {
    return this.#rest(`/repos/${owner}/${name}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } });
  }

  /**
   * Post `body` as a comment on issue/PR `number`, or edit the existing one that
   * carries `marker`. This is what keeps DiffHawk to a single living scorecard
   * instead of a new comment every run — the behaviour a noisy bot fails at.
   */
  async upsertMarkedComment(owner: string, name: string, number: number, marker: string, body: string): Promise<'created' | 'updated'> {
    const existing = (await this.listComments(owner, name, number)).find((c) => c.body.includes(marker));
    if (existing) {
      await this.updateComment(owner, name, existing.id, body);
      return 'updated';
    }
    await this.createComment(owner, name, number, body);
    return 'created';
  }

  /** Find an open issue whose body carries `marker`, or create one. */
  async findOrCreateTrackingIssue(owner: string, name: string, title: string, marker: string): Promise<number> {
    const found = await this.#rest<Array<{ number: number; body: string | null }>>(
      `/repos/${owner}/${name}/issues?state=open&per_page=100`,
    );
    const hit = found.find((i) => (i.body ?? '').includes(marker));
    if (hit) return hit.number;
    const created = await this.#rest<{ number: number }>(`/repos/${owner}/${name}/issues`, {
      method: 'POST',
      body: { title, body: `${marker}\n\nDiffHawk keeps this issue updated with the latest scorecard.` },
    });
    return created.number;
  }

  async #rest<T>(path: string, opts: { method?: string; body?: unknown } = {}, attempt = 0): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `bearer ${this.#token}`,
        'User-Agent': 'diffhawk',
        Accept: 'application/vnd.github+json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) throw new GitHubError('GitHub rejected the token (401).');
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 30);
      if (attempt >= 4) throw new RateLimitError(`Rate limited after ${attempt} retries.`);
      this.#log(`  rate limited, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.#rest<T>(path, opts, attempt + 1);
    }
    if (res.status >= 500) {
      if (attempt >= 4) throw new GitHubError(`GitHub ${res.status} after ${attempt} retries.`);
      await sleep(Math.min(2 ** attempt * 1000, 16000));
      return this.#rest<T>(path, opts, attempt + 1);
    }
    if (!res.ok) throw new GitHubError(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`);
    // 204 No Content and empty bodies are valid for some writes.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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

    // Surface GraphQL errors even when `data` is present. GitHub answers an
    // invalid argument with HTTP 200, a null field, AND an errors array; only
    // checking `!data` swallowed the real cause and let the caller report a
    // misleading "not found" instead of "first cannot exceed 100".
    if (json.errors?.length) {
      const fatal = json.errors.filter((e) => e.type !== 'NOT_FOUND' && e.type !== 'FORBIDDEN');
      if (fatal.length > 0) {
        throw new GitHubError(`GraphQL: ${fatal.map((e) => e.message).join('; ')}`);
      }
    }
    if (!json.data) throw new GitHubError('GraphQL returned no data.');
    return json.data;
  }
}
