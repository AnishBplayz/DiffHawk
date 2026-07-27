import type { Scorecard, Bucket } from '../schemas.ts';

/**
 * Hidden marker embedded in every posted scorecard. The Action finds its own
 * previous comment by this string and edits it in place, so a repo gets one
 * living scorecard instead of a new comment every run. Editing, not appending,
 * is the difference between a useful bot and the noisy ones DiffHawk measures.
 */
export const SCORECARD_MARKER = '<!-- diffhawk:scorecard -->';

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function verdictBadge(s: Scorecard): string {
  if (!s.baseline) return '';
  const map = {
    sharp: '🟢 **sharp** — earning its place',
    typical: '⚪ typical for this reviewer',
    weak: '🟡 **weak** — below par here',
    noise: '🔴 **noise** — barely acted on',
    insufficient: '⚫ not enough decided comments to judge',
  } as const;
  return map[s.baseline.verdict];
}

/** `dimension` names the first column (e.g. "severity"); rows are key/rate/count. */
function bucketTable(dimension: string, buckets: Bucket[]): string {
  const rows = buckets.filter((b) => b.comments > 0);
  if (rows.length === 0) return '';
  const body = rows
    .map((b) => `| ${b.key} | ${pct(b.effectiveness)} | ${b.actedOn}/${b.comments} |`)
    .join('\n');
  return (
    `\n**By ${dimension}**\n\n` +
    `| ${dimension} | acted-on | |\n| --- | ---: | ---: |\n${body}\n`
  );
}

/**
 * Render a scorecard as a GitHub-flavoured Markdown comment. Pure: scorecard in,
 * string out, so it is snapshot-testable and never touches the network.
 */
export function renderScorecardMarkdown(s: Scorecard): string {
  const L: string[] = [];
  L.push(SCORECARD_MARKER);
  L.push('');
  // Name the repo rather than saying "this repo": a scorecard can be posted on a
  // different repository than the one it scores.
  L.push(`### 🦅 DiffHawk — is \`${s.reviewer}\` working on \`${s.repo}\`?`);
  L.push('');
  const undecided = s.baseline?.verdict === 'insufficient';

  if (s.totals.decided === 0) {
    L.push(
      `No decided comments yet — all **${s.totals.pending}** are on open pull requests. ` +
        `There is nothing to score until they close.`,
    );
  } else {
    L.push(
      `**${pct(s.totals.effectiveness)}** of **${s.totals.decided}** decided comments led to a code change ` +
        `(${s.totals.actedOn} acted-on${s.totals.pending > 0 ? `, ${s.totals.pending} pending` : ''}).`,
    );
  }

  if (s.baseline) {
    const g = s.baseline.globalEffectiveness;
    L.push('');
    if (undecided) {
      // No "below average" claim off a sample too small to support one.
      L.push(`Census global for \`${s.reviewer}\`: **${pct(g)}**. ${verdictBadge(s)}`);
    } else {
      const rel = s.totals.effectiveness < g * 0.85 ? 'below' : s.totals.effectiveness > g * 1.15 ? 'above' : 'about';
      L.push(`Census global for \`${s.reviewer}\`: **${pct(g)}** — this repo is *${rel}* average. ${verdictBadge(s)}`);
    }
  }

  if (s.trend) {
    const d = s.trend.deltaPts;
    const arrow = d >= 2 ? '📈' : d <= -2 ? '📉' : '➡️';
    const sign = d >= 0 ? '+' : '';
    L.push('');
    L.push(`${arrow} Trend vs previous window: **${sign}${d.toFixed(0)} pts** (was ${pct(s.trend.previousEffectiveness)}).`);
  }

  if (s.flags.length) {
    L.push('');
    for (const f of s.flags) L.push(`> ⚑ ${f.detail}`);
  }

  L.push(bucketTable('severity', s.bySeverity));
  const topAreas = s.byArea.slice(0, 6);
  if (topAreas.length) L.push(bucketTable('area', topAreas));

  L.push('');
  L.push('<details><summary>How to read this &amp; caveats</summary>\n');
  for (const c of s.caveats) L.push(`- ${c}`);
  L.push('');
  L.push(
    `_Window ${s.window.from} → ${s.window.to}. DiffHawk measures whether a reviewer's ` +
      `comments lead to code changes; it does not judge whether the code is correct._`,
  );
  L.push('</details>');
  L.push('');
  return L.join('\n');
}
