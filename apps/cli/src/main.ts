#!/usr/bin/env bun
/**
 * diffhawk score <owner/repo> — the funnel surface.
 *
 * Fetch a repo's recent review threads, score whichever AI reviewer runs there,
 * and print the scorecard. Zero infrastructure: a token (or `gh auth`) and one
 * command. Everything the census proved feeds this — the bot registry, the
 * action proxy, and the global baseline the scorecard compares against.
 */

import { scoreRepo, renderScorecard } from '@diffhawk/core';
import { GitHubClient, GitHubError, resolveToken } from '@diffhawk/github';
import { CENSUS_BASELINE, CENSUS_META } from '@diffhawk/ingest';

interface Args {
  repo: string | null;
  reviewer?: string;
  prLimit: number;
  windowDays: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { repo: null, prLimit: 60, windowDays: 90, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--reviewer') args.reviewer = argv[++i];
    else if (a === '--prs') args.prLimit = Number(argv[++i]);
    else if (a === '--days') args.windowDays = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('-') && !args.repo) args.repo = a;
  }
  return args;
}

const USAGE = `
diffhawk score <owner/repo> [options]

  Measure whether the AI code reviewer running on a repo is actually working.

Options:
  --reviewer <name>   Score a specific reviewer (default: the most active one)
  --prs <n>           Recent pulls to inspect (default 60)
  --days <n>          Reporting window in days (default 90)
  --json              Emit the raw scorecard as JSON

Auth:
  Uses GITHUB_TOKEN if set, otherwise falls back to \`gh auth token\`.
  Read-only: it only reads public pull requests.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Allow `diffhawk score owner/repo` and `diffhawk owner/repo` alike.
  const rest = argv[0] === 'score' ? argv.slice(1) : argv;
  const args = parseArgs(rest);

  if (!args.repo || rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(USAGE);
    return args.repo ? 0 : 1;
  }

  const slug = args.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [owner, name] = slug.split('/');
  if (!owner || !name) {
    process.stderr.write(`Not a valid repo: "${args.repo}". Expected owner/repo.\n`);
    return 1;
  }

  const token = resolveToken();
  if (!token) {
    process.stderr.write(
      'No GitHub credentials. Run `gh auth login`, or set GITHUB_TOKEN (public_repo scope, read-only).\n',
    );
    return 1;
  }

  const client = new GitHubClient({ token, onLog: (m) => process.stderr.write(m + '\n') });

  let data;
  try {
    process.stderr.write(`Fetching ${owner}/${name} …\n`);
    data = await client.fetchRepoPulls(owner, name, args.prLimit);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return err instanceof GitHubError ? 1 : 2;
  }

  const to = new Date();
  const from = new Date(to.getTime() - args.windowDays * 864e5);
  const { scorecard, reviewersSeen } = scoreRepo(data, {
    reviewer: args.reviewer,
    baseline: CENSUS_BASELINE,
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
  });

  if (!scorecard) {
    if (reviewersSeen.length === 0) {
      process.stdout.write(
        `\n  No AI reviewer found on ${owner}/${name} in the last ${args.prLimit} pulls.\n` +
          `  (~62% of active repos run none — see ${CENSUS_META.source})\n\n`,
      );
    } else {
      process.stdout.write(
        `\n  No inline comments to score for ${args.reviewer ?? 'that reviewer'}.\n` +
          `  Reviewers seen: ${reviewersSeen.map((r) => `${r.reviewer} (${r.comments})`).join(', ')}\n\n`,
      );
    }
    return 0;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(scorecard, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(renderScorecard(scorecard));
  if (reviewersSeen.length > 1) {
    const others = reviewersSeen
      .filter((r) => r.reviewer !== scorecard.reviewer)
      .map((r) => `${r.reviewer} (${r.comments})`)
      .join(', ');
    process.stderr.write(`  other reviewers here: ${others}\n\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Unexpected error: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  },
);
