import type { Scorecard, Bucket } from '../schemas.ts';

/** Minimal ANSI, disabled when not a TTY or when NO_COLOR is set. */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const red = (s: string) => c('31', s);
const yellow = (s: string) => c('33', s);
const green = (s: string) => c('32', s);

const pctColor = (eff: number): ((s: string) => string) =>
  eff < 0.15 ? red : eff < 0.3 ? yellow : eff >= 0.6 ? green : (s) => s;

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function bar(eff: number, width = 16): string {
  const filled = Math.round(eff * width);
  return pctColor(eff)('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function bucketRows(title: string, buckets: Bucket[]): string {
  if (buckets.length === 0) return '';
  const keyW = Math.max(title.length, ...buckets.map((b) => b.key.length));
  const lines = buckets
    .filter((b) => b.comments > 0)
    .map((b) => {
      const key = b.key.padEnd(keyW);
      const rate = pctColor(b.effectiveness)(pct(b.effectiveness).padStart(4));
      const n = dim(`${b.actedOn}/${b.comments}`);
      return `    ${key}  ${bar(b.effectiveness)}  ${rate}  ${n}`;
    });
  return `  ${dim(title)}\n${lines.join('\n')}`;
}

const VERDICT_LABEL: Record<NonNullable<Scorecard['baseline']>['verdict'], string> = {
  sharp: green('sharp — earning its place'),
  typical: 'typical for this reviewer',
  weak: yellow('weak — below par here'),
  noise: red('noise — barely acted on'),
  insufficient: dim('not enough decided comments to judge'),
};

/** Render a scorecard as a terminal report. Pure string in, string out. */
export function renderScorecard(s: Scorecard): string {
  const L: string[] = [];
  const eff = s.totals.effectiveness;

  L.push('');
  L.push(`  ${bold(s.reviewer)} on ${bold(s.repo)}  ${dim('· ' + s.window.from + ' → ' + s.window.to)}`);
  L.push('');
  const pendingNote = s.totals.pending > 0 ? `, ${s.totals.pending} pending` : '';
  const undecided = s.baseline?.verdict === 'insufficient';

  if (s.totals.decided === 0) {
    L.push(
      `  ${yellow('No decided comments yet')} — all ${s.totals.pending} are on open PRs.` +
        `  ${dim('Nothing to score until they close.')}`,
    );
  } else {
    L.push(
      `  ${bold(pctColor(eff)(pct(eff)))} of ${s.totals.decided} decided comments led to a code change` +
        `  ${dim(`(${s.totals.actedOn} acted-on${pendingNote})`)}`,
    );
  }

  if (s.baseline) {
    const g = s.baseline.globalEffectiveness;
    // Only compare against the baseline when the sample can support it — a
    // "below average" claim off 3 comments is noise dressed as a finding.
    if (undecided) {
      L.push(`  ${dim('census global for ' + s.reviewer + ':')} ${pct(g)}  ·  ${VERDICT_LABEL[s.baseline.verdict]}`);
    } else {
      const rel = eff < g * 0.85 ? red('below') : eff > g * 1.15 ? green('above') : 'about';
      L.push(
        `  ${dim('census global for ' + s.reviewer + ':')} ${pct(g)}  ${dim('— this repo is')} ${rel} ${dim('average')}  ·  ${VERDICT_LABEL[s.baseline.verdict]}`,
      );
    }
  }

  if (s.trend) {
    const d = s.trend.deltaPts;
    const sign = d >= 0 ? '+' : '';
    const col = d <= -2 ? red : d >= 2 ? green : (x: string) => x;
    L.push(
      `  ${dim('trend vs previous window:')} ${col(`${sign}${d.toFixed(0)} pts`)}  ${dim(`(was ${pct(s.trend.previousEffectiveness)})`)}`,
    );
  }
  L.push('');

  const sev = bucketRows('by severity', s.bySeverity);
  if (sev) { L.push(sev); L.push(''); }

  const topAreas = s.byArea.slice(0, 6);
  const area = bucketRows('by area (top ' + topAreas.length + ')', topAreas);
  if (area) { L.push(area); L.push(''); }

  if (s.flags.length) {
    for (const f of s.flags) L.push(`  ${yellow('⚑')} ${f.detail}`);
    L.push('');
  }

  L.push(dim('  caveats'));
  for (const cav of s.caveats) {
    // wrap each caveat to ~76 cols under a hanging indent
    L.push(dim(wrap(cav, 74, '    ', '      ')));
  }
  L.push('');
  return L.join('\n');
}

function wrap(text: string, width: number, first: string, hang: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = first;
  for (const w of words) {
    if (line.length + w.length + 1 > width && line.trim().length > 0) {
      lines.push(line);
      line = hang + w;
    } else {
      line += (line.endsWith(' ') || line === first || line === hang ? '' : ' ') + w;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join('\n');
}
