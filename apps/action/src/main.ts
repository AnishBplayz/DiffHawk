#!/usr/bin/env bun
/**
 * DiffHawk GitHub Action entrypoint.
 *
 * Reads the Actions environment, scores whichever AI reviewer runs on this repo,
 * writes the scorecard to the job summary, and — unless disabled — upserts a
 * single living scorecard comment (on the PR when triggered by one, otherwise on
 * a tracking issue). One comment, edited in place, never a wall of duplicates.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { scoreRepo, renderScorecard, renderScorecardMarkdown, SCORECARD_MARKER, DEFAULT_IGNORE_GLOBS } from '@diffhawk/core';
import { GitHubClient, resolveToken, GitHubError } from '@diffhawk/github';
import { CENSUS_BASELINE } from '@diffhawk/ingest';
import { parseConfig, type DiffhawkConfig } from '@diffhawk/config';

function input(name: string): string | undefined {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Load `.diffhawk.yml` from the caller's checked-out repo. The composite action
 * runs from its own directory, so config is resolved against GITHUB_WORKSPACE
 * (the user's repo), not cwd. Config is optional — no file means sane defaults.
 */
function loadConfig(): DiffhawkConfig {
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  for (const rel of ['.diffhawk.yml', '.diffhawk.yaml', '.github/diffhawk.yml']) {
    const path = `${root}/${rel}`;
    try {
      const raw = readFileSync(path, 'utf8');
      const { config } = parseConfig(Bun.YAML.parse(raw));
      process.stderr.write(`Loaded config from ${rel}\n`);
      return config;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err; // a present-but-invalid config should fail loudly
    }
  }
  return parseConfig(null).config;
}

/** PR number from the event payload, when the run was triggered by a PR. */
function eventPrNumber(): number | null {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const ev = JSON.parse(readFileSync(path, 'utf8'));
    return typeof ev.pull_request?.number === 'number' ? ev.pull_request.number : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const hostSlug = process.env.GITHUB_REPOSITORY;
  if (!hostSlug) {
    process.stderr.write('GITHUB_REPOSITORY not set — is this running in GitHub Actions?\n');
    return 1;
  }
  const [hostOwner, hostName] = hostSlug.split('/');
  if (!hostOwner || !hostName) {
    process.stderr.write(`Bad GITHUB_REPOSITORY: ${hostSlug}\n`);
    return 1;
  }

  /**
   * The repo being SCORED may differ from the repo the workflow runs in.
   *
   * Reporting always stays on the host repo: writing a comment into someone
   * else's repository is not something a measurement tool should do, and the
   * token usually could not anyway.
   */
  const target = (input('repo') ?? hostSlug).replace(/^https?:\/\/github\.com\//, '');
  const [owner, name] = target.split('/');
  if (!owner || !name) {
    process.stderr.write(`Bad repo input: "${target}". Expected owner/name.\n`);
    return 1;
  }
  const scoringSelf = `${owner}/${name}`.toLowerCase() === hostSlug.toLowerCase();

  const token = input('token') ?? resolveToken();
  if (!token) {
    process.stderr.write('No token. Pass `token: ${{ secrets.GITHUB_TOKEN }}` or set GITHUB_TOKEN.\n');
    return 1;
  }

  const config = loadConfig();
  const windowDays = Number(input('days') ?? config.windowDays);
  const prLimit = Number(input('prs') ?? config.prLimit);
  const reviewer = input('reviewer') ?? (Array.isArray(config.reviewers) ? config.reviewers[0] : undefined);
  const post = (input('post') ?? String(config.report.postScorecard)) !== 'false';

  const client = new GitHubClient({ token, onLog: (m) => process.stderr.write(m + '\n') });

  process.stderr.write(
    `Scoring ${owner}/${name} (window ${windowDays}d, ${prLimit} PRs)` +
      (scoringSelf ? '' : `, reporting on ${hostSlug}`) +
      '…\n',
  );
  let data;
  try {
    data = await client.fetchRepoPulls(owner, name, prLimit);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof GitHubError ? 1 : 2;
  }

  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 864e5);
  const { scorecard, reviewersSeen } = scoreRepo(data, {
    reviewer,
    baseline: CENSUS_BASELINE,
    // User ignores extend the defaults rather than replacing them.
    ignoreGlobs: [...DEFAULT_IGNORE_GLOBS, ...config.ignore],
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    detectTrend: true,
    degradationDropPts: config.flags.degradationDropPts,
  });

  if (!scorecard) {
    const msg = reviewersSeen.length
      ? `No inline comments to score. Reviewers seen: ${reviewersSeen.map((r) => r.reviewer).join(', ')}`
      : 'No AI reviewer found on recent PRs — nothing to score.';
    process.stderr.write(msg + '\n');
    writeSummary(`### 🦅 DiffHawk\n\n${msg}\n`);
    return 0;
  }

  // Always: terminal log + job summary.
  process.stdout.write(renderScorecard(scorecard));
  const md = renderScorecardMarkdown(scorecard);
  writeSummary(md);

  if (!post) {
    process.stderr.write('Posting disabled (report.post_scorecard: false).\n');
    return 0;
  }

  try {
    // Comments go to the HOST repo, never the scored one.
    const prNumber = scoringSelf ? eventPrNumber() : null;
    if (prNumber) {
      const r = await client.upsertMarkedComment(hostOwner, hostName, prNumber, SCORECARD_MARKER, md);
      process.stderr.write(`Scorecard ${r} on PR #${prNumber}\n`);
    } else {
      const title = scoringSelf ? 'DiffHawk scorecard' : `DiffHawk scorecard: ${owner}/${name}`;
      // Marker is per-target so scoring several repos keeps one issue each
      // instead of fighting over a single thread. It must also be present in the
      // BODY, otherwise the next run cannot find its own comment and appends a
      // new one every time, which is the duplicate wall this design avoids.
      const marker = scoringSelf ? SCORECARD_MARKER : `${SCORECARD_MARKER}<!-- target:${owner}/${name} -->`;
      const body = scoringSelf ? md : md.replace(SCORECARD_MARKER, marker);
      const issue = await client.findOrCreateTrackingIssue(hostOwner, hostName, title, marker);
      const r = await client.upsertMarkedComment(hostOwner, hostName, issue, marker, body);
      process.stderr.write(`Scorecard ${r} on tracking issue #${issue}\n`);
    }
  } catch (err) {
    // Posting failure should not fail the build — the summary already carries
    // the scorecard. Report and exit clean.
    process.stderr.write(`Could not post scorecard: ${(err as Error).message}\n`);
  }
  return 0;
}

function writeSummary(md: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, md + '\n');
  } catch {
    /* summary is best-effort */
  }
}

main().then((c) => process.exit(c), (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exit(2); });
