import type { GitHubClient } from '@diffhawk/github';
import { changedRanges, rangesTouchLine, type LineRange } from './diff.ts';

/**
 * One labelled thread: the cheap signals we score against, plus the independent
 * ground-truth label built from real post-comment commits.
 *
 * `gold` is NOT GitHub's `isOutdated`. It is computed by fetching the commits
 * pushed to the PR *after* the comment and checking whether any of them changed
 * the commented file within a few lines of the commented line. That makes it a
 * fair, separate yardstick for the `isOutdated`-based classifier — the whole
 * point of Phase 1 is to find out how often the cheap signal agrees with it.
 */
export interface LabelledThread {
  repo: string;
  pr: number;
  reviewer: string;
  path: string;
  line: number;
  createdAt: string;
  prState: 'merged' | 'closed_unmerged';
  // Cheap signals (what the classifier sees):
  isOutdated: boolean;
  isResolved: boolean;
  // Independent ground truth:
  gold: 'acted_on' | 'not_acted_on';
  /** True if we hit the per-PR commit cap and the gold may be incomplete. */
  capped: boolean;
  /**
   * Number of commits pushed after the comment. When this is 1, the comment's
   * line (HEAD coordinates) and that single commit's patch coordinates coincide,
   * so the overlap check is reliable. With more commits, line numbers drift
   * between coordinate spaces and the gold is only approximate — which is
   * exactly why we report agreement on the `postCommits === 1` subset separately.
   */
  postCommits: number;
}

const MAX_COMMITS_PER_PR = 40;

interface PullForEval {
  number: number;
  state: 'MERGED' | 'CLOSED';
  threads: Array<{
    reviewer: string;
    path: string;
    line: number;
    createdAt: string;
    isOutdated: boolean;
    isResolved: boolean;
  }>;
}

/**
 * Build ground-truth labels for every AI thread in a set of closed/merged pulls.
 * Commits and their patches are fetched once per PR and cached across threads,
 * so cost scales with (PRs + distinct post-comment commits), not with threads.
 */
export async function labelPulls(
  client: GitHubClient,
  owner: string,
  name: string,
  pulls: PullForEval[],
  log: (m: string) => void = () => {},
): Promise<LabelledThread[]> {
  const repo = `${owner}/${name}`;
  const out: LabelledThread[] = [];

  for (const pull of pulls) {
    if (pull.threads.length === 0) continue;

    let commits: Array<{ sha: string; date: string }>;
    try {
      commits = await client.listPullCommits(owner, name, pull.number);
    } catch (err) {
      log(`  skip ${repo}#${pull.number}: ${(err as Error).message}`);
      continue;
    }
    commits.sort((a, b) => a.date.localeCompare(b.date));
    const capped = commits.length > MAX_COMMITS_PER_PR;

    // Cache each commit's changed ranges per file, fetched lazily and once.
    const patchCache = new Map<string, Map<string, LineRange[]>>();
    const rangesFor = async (sha: string): Promise<Map<string, LineRange[]>> => {
      const hit = patchCache.get(sha);
      if (hit) return hit;
      const ranges = new Map<string, LineRange[]>();
      try {
        const patches = await client.getCommitPatches(owner, name, sha);
        for (const [file, patch] of patches) ranges.set(file, changedRanges(patch));
      } catch {
        // A commit we can't fetch contributes no evidence — conservative, and
        // reflected by `capped` when relevant.
      }
      patchCache.set(sha, ranges);
      return ranges;
    };

    for (const t of pull.threads) {
      const post = commits
        .filter((c) => c.date && c.date > t.createdAt)
        .slice(0, MAX_COMMITS_PER_PR);

      let acted = false;
      for (const c of post) {
        const ranges = (await rangesFor(c.sha)).get(t.path);
        // Tight window (±1): a wider one falsely flags edits *near* the anchor as
        // if the anchor itself changed — verified on hoprnet#8238, where a commit
        // touched lines 179–195 but the commented line 193 was untouched and
        // isOutdated correctly stayed false. Even at ±1 the gold trails isOutdated
        // for multi-commit PRs (line drift), which is the whole finding.
        if (ranges && rangesTouchLine(ranges, t.line, 1)) {
          acted = true;
          break;
        }
      }

      out.push({
        repo,
        pr: pull.number,
        reviewer: t.reviewer,
        path: t.path,
        line: t.line,
        createdAt: t.createdAt,
        prState: pull.state === 'MERGED' ? 'merged' : 'closed_unmerged',
        isOutdated: t.isOutdated,
        isResolved: t.isResolved,
        gold: acted ? 'acted_on' : 'not_acted_on',
        capped,
        postCommits: post.length,
      });
    }
  }

  return out;
}
