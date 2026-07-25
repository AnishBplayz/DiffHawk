#!/usr/bin/env bun
/**
 * diffhawk eval — validate the cheap outcome signal against a ground truth.
 *
 * Live mode fetches repos, builds commit-derived gold labels for every AI review
 * thread on their closed/merged PRs, writes a frozen corpus, and reports how
 * often the `isOutdated`-based classifier agrees. Offline mode re-scores a frozen
 * corpus with no network — deterministic, and the basis for a future CI gate.
 *
 *   bun run packages/eval/src/run.ts <owner/repo> [more…] [--prs 40] [--out file]
 *   bun run packages/eval/src/run.ts --corpus packages/eval/corpus/seed.jsonl
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { GitHubClient, resolveToken, GitHubError } from '@diffhawk/github';
import { identifyBot } from '@diffhawk/ingest';
import { labelPulls, evaluate, formatMetrics, type LabelledThread } from './index.ts';

function parse(argv: string[]) {
  const repos: string[] = [];
  let prs = 40, out = 'packages/eval/corpus/latest.jsonl', corpus: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--prs') prs = Number(argv[++i]);
    else if (a === '--out') out = argv[++i]!;
    else if (a === '--corpus') corpus = argv[++i]!;
    else if (!a.startsWith('-')) repos.push(a);
  }
  return { repos, prs, out, corpus };
}

function readCorpus(path: string): LabelledThread[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LabelledThread);
}

async function collect(client: GitHubClient, repos: string[], prs: number): Promise<LabelledThread[]> {
  const all: LabelledThread[] = [];
  for (const slug of repos) {
    const [owner, name] = slug.split('/');
    if (!owner || !name) { process.stderr.write(`skip "${slug}" (want owner/repo)\n`); continue; }
    process.stderr.write(`Fetching ${slug} …\n`);

    let data;
    try {
      data = await client.fetchRepoPulls(owner, name, prs);
    } catch (err) {
      process.stderr.write(`  ${(err as Error).message}\n`);
      continue;
    }

    // Only closed/merged PRs have a decided outcome to check; only AI threads
    // with a concrete line can be located in a commit diff.
    const pulls = data.pulls
      .filter((p) => p.state !== 'OPEN')
      .map((p) => ({
        number: p.number,
        state: p.state as 'MERGED' | 'CLOSED',
        threads: p.threads.flatMap((t) => {
          const bot = identifyBot(t.reviewerLogin);
          if (bot?.category !== 'ai-review' || t.line == null) return [];
          return [{
            reviewer: bot.vendor, path: t.path, line: t.line,
            createdAt: t.createdAt, isOutdated: t.isOutdated, isResolved: t.isResolved,
          }];
        }),
      }))
      .filter((p) => p.threads.length > 0);

    const labelled = await labelPulls(client, owner, name, pulls, (m) => process.stderr.write(m + '\n'));
    all.push(...labelled);
    process.stderr.write(`  ${labelled.length} labelled threads\n`);
  }
  return all;
}

async function main(): Promise<number> {
  const { repos, prs, out, corpus } = parse(process.argv.slice(2));

  let labelled: LabelledThread[];
  if (corpus) {
    if (!existsSync(corpus)) { process.stderr.write(`No corpus at ${corpus}\n`); return 1; }
    labelled = readCorpus(corpus);
    process.stderr.write(`Re-scoring ${labelled.length} threads from ${corpus} (offline)\n`);
  } else {
    if (repos.length === 0) { process.stderr.write('Usage: eval <owner/repo…> | --corpus <file>\n'); return 1; }
    const token = resolveToken();
    if (!token) { process.stderr.write('No GitHub credentials (gh auth login or GITHUB_TOKEN).\n'); return 1; }
    const client = new GitHubClient({ token, onLog: (m) => process.stderr.write(m + '\n') });
    try {
      labelled = await collect(client, repos, prs);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return err instanceof GitHubError ? 1 : 2;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, labelled.map((r) => JSON.stringify(r)).join('\n') + '\n');
    process.stderr.write(`\nWrote ${labelled.length} labelled threads to ${out}\n`);
  }

  const m = evaluate(labelled);
  process.stdout.write('\n' + formatMetrics(m) + '\n');

  if (m.inflation.examples.length) {
    process.stdout.write('\n  inflation examples (isOutdated=acted, no post-comment commit touched the line):\n');
    for (const e of m.inflation.examples) process.stdout.write(`    ${e.repo}#${e.pr} ${e.path}:${e.line} (${e.prState})\n`);
  }
  process.stdout.write('\n');
  return 0;
}

main().then((c) => process.exit(c), (e) => { process.stderr.write(`${(e as Error).stack}\n`); process.exit(2); });
