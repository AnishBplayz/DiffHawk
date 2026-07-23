/**
 * Ports — the seams between the pure engine and the outside world.
 *
 * `packages/core` depends on these interfaces, never on Octokit, fetch, a
 * database, or a clock. Adapters (packages/github, packages/db, the CLI) supply
 * implementations. This is what lets the whole pipeline run against a fixture in
 * a test with zero I/O — the precondition for a scoring-regression gate.
 */

/** A raw review thread as a provider hands it over, before normalisation. */
export interface RawThread {
  reviewerLogin: string | null;
  reviewerIsBot: boolean;
  path: string;
  line: number | null;
  /** Bounded excerpt of the opening comment — used for severity inference only. */
  body: string;
  createdAt: string;
  isOutdated: boolean;
  isResolved: boolean;
}

export interface RawPull {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  threads: RawThread[];
}

export interface RepoPulls {
  owner: string;
  name: string;
  pulls: RawPull[];
  /** Reviewers found by summary comment/review even without inline threads. */
  reviewerLoginsSeen: string[];
}

/**
 * Reads review activity from a version-control host. The only capability the
 * Phase-0 engine needs; webhook verification and writes live in later ports.
 */
export interface VcsProvider {
  /**
   * Fetch recent pulls with their review threads for one repository.
   * @param prLimit most-recently-updated pulls to inspect.
   */
  fetchRepoPulls(owner: string, name: string, prLimit: number): Promise<RepoPulls>;
}

/** Wall clock, injected so scoring windows are deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
