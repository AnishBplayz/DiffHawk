#!/usr/bin/env bun
/**
 * Build the publishable `diffhawk` npm package.
 *
 * Publishing the workspace as-is would ship something broken, in three ways:
 *
 *   1. `apps/cli` depends on `@diffhawk/*` via `workspace:*`, which does not
 *      resolve for anyone installing from the registry.
 *   2. `bin` points at a `.ts` file, which node cannot execute, so `npx
 *      diffhawk` fails immediately for users without a TypeScript runtime.
 *   3. The package name is scoped to an org that does not exist.
 *
 * So the CLI is bundled into ONE JavaScript file with every dependency inlined,
 * targeting node rather than bun. Zero runtime dependencies means an instant
 * install, no resolution surprises, and `npx diffhawk` working on a stock node.
 */

import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'dist-npm');
const VERSION = '0.1.0';

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, 'apps/cli/src/main.ts')],
    outdir: OUT,
    // node, not bun: most people running `npx diffhawk` will not have bun.
    target: 'node',
    format: 'esm',
    minify: false, // readable output; a reviewer can check what they installed
    naming: 'diffhawk.js',
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('bundle failed');
  }

  /**
   * Normalise the header rather than using `banner`.
   *
   * The entrypoint carries its own `#!/usr/bin/env bun` shebang, and bun keeps it
   * plus a `// @bun` marker. A banner lands AFTER those, so the first line of the
   * file stayed `bun` and `npx diffhawk` would have failed for every user without
   * bun installed. Strip whatever leading shebang/marker lines exist, then put a
   * single node shebang first.
   */
  const bundlePath = join(OUT, 'diffhawk.js');
  const lines = (await Bun.file(bundlePath).text()).split('\n');
  let start = 0;
  while (start < lines.length && /^(#!|\/\/ @bun\s*$)/.test(lines[start] ?? '')) start++;
  await writeFile(bundlePath, '#!/usr/bin/env node\n' + lines.slice(start).join('\n'));
  await Bun.$`chmod +x ${bundlePath}`.quiet();

  const pkg = {
    name: 'diffhawk',
    version: VERSION,
    description:
      'Measure whether the AI code reviewer running on your repo is actually working. Built on a study of 1,112 repositories.',
    type: 'module',
    bin: { diffhawk: './diffhawk.js' },
    files: ['diffhawk.js', 'README.md', 'LICENSE'],
    // Fully bundled on purpose: nothing to resolve, nothing to drift.
    dependencies: {},
    engines: { node: '>=20' },
    keywords: [
      'code-review',
      'ai-code-review',
      'coderabbit',
      'copilot',
      'metrics',
      'github',
      'developer-tools',
    ],
    repository: { type: 'git', url: 'git+https://github.com/AnishBplayz/DiffHawk.git' },
    homepage: 'https://github.com/AnishBplayz/DiffHawk#readme',
    bugs: { url: 'https://github.com/AnishBplayz/DiffHawk/issues' },
    license: 'Apache-2.0',
    author: 'Anish Bhutra',
  };

  await writeFile(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await cp(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'));
  await writeFile(join(OUT, 'README.md'), npmReadme());

  const size = (await Bun.file(join(OUT, 'diffhawk.js')).arrayBuffer()).byteLength;
  console.log(`built dist-npm/diffhawk.js  (${(size / 1024).toFixed(0)} kB, ${VERSION})`);
}

/**
 * A focused README for the npm listing. The repo README covers the Action and
 * the self-hosted stack, which are noise for someone who just ran `npx`.
 */
function npmReadme(): string {
  return `# diffhawk

Measure whether the AI code reviewer running on your repo is actually working.

\`\`\`bash
npx diffhawk score kubeedge/kubeedge
\`\`\`

\`\`\`
  Gemini on kubeedge/kubeedge  · 2026-04-28 → 2026-07-27

  65% of 26 decided comments led to a code change  (17 acted-on, 16 pending)
  census global for Gemini: 44%  — this repo is above average  ·  sharp — earning its place

  by severity
    critical     ████████░░░░░░░░   50%  2/4
    high         █████████████░░░   80%  4/5
    unknown      ██████████░░░░░░   65%  11/17
\`\`\`

## Why compare at all

Across 1,112 public repositories, AI reviewer comments led to a code change 43% of
the time on average. That average is the problem, not the finding: per repository
it ranges from **14% to 70%**, and about **1 in 5 repos sit at 25% or below** —
some near zero. Their teams cannot tell, because the average is the only number
they have seen.

[The study, its method and its raw data](https://github.com/AnishBplayz/ai-reviewer-census).

## Usage

\`\`\`bash
npx diffhawk score <owner>/<repo> [options]

  --reviewer <name>   Score one reviewer (default: the most active)
  --prs <n>           Pull requests to inspect (default 120)
  --days <n>          Reporting window in days (default 90)
  --json              Emit the raw scorecard as JSON
\`\`\`

Auth uses \`GITHUB_TOKEN\`, falling back to \`gh auth token\`. Read-only: it reads
public pull requests and writes nothing.

## How far to trust the number

"Acted on" means the code a comment points at changed afterwards, from GitHub's
own thread state. That is a proxy for influence, not proof of correctness, and it
is wrong in two known directions: a rebase touching the same lines counts when it
should not, and a fix elsewhere in the file does not count when it should. Both
biases are printed on every scorecard.

An attempt to validate that signal against commit history **failed** — the
validation signal proved noisier than the thing it was validating. That is
written up rather than hidden:
[EVAL.md](https://github.com/AnishBplayz/DiffHawk/blob/main/EVAL.md).

Comments on still-open pull requests are excluded as undecided rather than
counted as failures, and no verdict is issued below 10 decided comments.

## Also available

- **GitHub Action** — a weekly scorecard comment on your repo
- **Self-hosted** — NestJS API + BullMQ workers + Postgres for fleet scale

Both in the [main repository](https://github.com/AnishBplayz/DiffHawk).

Apache-2.0.
`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
