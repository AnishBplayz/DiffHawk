import type { Scorecard as ScorecardData, Bucket } from '@diffhawk/core';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Verdict is a status, so it ships as colour PLUS a word. Colour alone would
 * fail for a colourblind reader, and this is the one number people will quote.
 */
const VERDICT: Record<string, { label: string; tone: string }> = {
  sharp: { label: 'Earning its place', tone: 'var(--good)' },
  typical: { label: 'Typical for this reviewer', tone: 'var(--ink-secondary)' },
  weak: { label: 'Below par here', tone: 'var(--warn)' },
  noise: { label: 'Barely acted on', tone: 'var(--bad)' },
  insufficient: { label: 'Not enough data to judge', tone: 'var(--ink-muted)' },
};

/**
 * One row of the breakdown. The bar encodes a single measure (rate), so every
 * row uses the same hue: colour here means magnitude, not identity. The count is
 * printed beside it because a bar alone hides how thin a sample is.
 */
function BarRow({ bucket, maxComments }: { bucket: Bucket; maxComments: number }) {
  const width = Math.max(bucket.effectiveness * 100, bucket.effectiveness > 0 ? 1.5 : 0);
  // Thin samples get a lighter fill so a 100% off 2 comments cannot masquerade
  // as a strong result.
  const confident = bucket.comments >= Math.max(8, maxComments * 0.15);

  return (
    // The label column must be allowed to SHRINK and the bar column needs a
    // floor. With a fixed label width these rows collapsed the bar to 0px inside
    // a narrow container, so the chart silently rendered as a bare table.
    <div className="grid grid-cols-[minmax(0,7rem)_minmax(2.5rem,1fr)_auto] items-center gap-x-3 py-[7px]">
      <span className="truncate text-[13px] text-ink-secondary" title={bucket.key}>
        {bucket.key}
      </span>

      <div className="relative h-[9px] overflow-hidden rounded-[4px] bg-hairline">
        <div
          className="bar-grow absolute inset-y-0 left-0 origin-left rounded-[4px]"
          style={{
            width: `${width}%`,
            background: 'var(--accent)',
            opacity: confident ? 1 : 0.45,
          }}
        />
      </div>

      <span className="nums text-right text-[13px] tabular-nums">
        <span className="text-ink">{pct(bucket.effectiveness)}</span>
        <span className="ml-2 text-ink-muted">
          {bucket.actedOn}/{bucket.comments}
        </span>
      </span>
    </div>
  );
}

function Breakdown({ title, buckets }: { title: string; buckets: Bucket[] }) {
  const rows = buckets.filter((b) => b.comments > 0);
  if (rows.length === 0) return null;
  const maxComments = Math.max(...rows.map((r) => r.comments));

  return (
    <div>
      <h3 className="mb-1 text-[12px] font-medium text-ink-muted">{title}</h3>
      <div className="divide-y divide-hairline">
        {rows.map((b) => (
          <BarRow key={b.key} bucket={b} maxComments={maxComments} />
        ))}
      </div>
    </div>
  );
}

export function Scorecard({ data, compact = false }: { data: ScorecardData; compact?: boolean }) {
  const v = data.baseline ? (VERDICT[data.baseline.verdict] ?? VERDICT.typical!) : null;
  const eff = data.totals.effectiveness;
  const undecided = data.baseline?.verdict === 'insufficient';
  const baselinePos = data.baseline ? Math.round(data.baseline.globalEffectiveness * 100) : null;

  return (
    <section
      className="rounded-xl border border-hairline bg-surface-raised p-5 sm:p-7"
      aria-label={`Scorecard for ${data.reviewer} on ${data.repo}`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-medium">
          <span className="text-ink">{data.reviewer}</span>
          <span className="text-ink-muted"> on </span>
          <span className="nums text-ink">{data.repo}</span>
        </h2>
        <span className="nums text-[11px] text-ink-muted">
          {data.window.from} to {data.window.to}
        </span>
      </header>

      {/* Hero number. A single value with a reference marker, not a chart. */}
      <div className="mt-6">
        {data.totals.decided === 0 ? (
          <p className="text-[15px] text-ink-secondary">
            No decided comments yet. All {data.totals.pending} are on open pull requests, so there
            is nothing to score until they close.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
            <span className="nums text-[52px] leading-[0.9] font-medium tracking-tight text-ink sm:text-[64px]">
              {pct(eff)}
            </span>
            <span className="max-w-[22rem] pb-1 text-[13px] leading-snug text-ink-secondary">
              of {data.totals.decided} decided comments led to a code change
              {data.totals.pending > 0 ? `, ${data.totals.pending} still pending` : ''}.
            </span>
          </div>
        )}

        {v && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-medium"
              style={{ borderColor: v.tone, color: v.tone }}
            >
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ background: v.tone }}
              />
              {v.label}
            </span>
            {!undecided && baselinePos !== null && (
              <span className="text-[12px] text-ink-muted">
                Global average for {data.reviewer} is{' '}
                <span className="nums text-ink-secondary">{baselinePos}%</span>
              </span>
            )}
          </div>
        )}

        {/* Position against the census baseline. A one-dimensional scale reads
            faster than a second chart, and it is the comparison people want. */}
        {!undecided && data.baseline && (
          <div className="mt-5">
            <div className="relative h-[6px] rounded-full bg-hairline">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${Math.min(eff * 100, 100)}%`, background: 'var(--accent)' }}
              />
              <div
                className="absolute -top-1 h-[14px] w-[2px] rounded-full bg-ink-secondary"
                style={{ left: `${Math.min(baselinePos ?? 0, 100)}%` }}
                aria-hidden
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-ink-muted">
              <span>this repo</span>
              <span>global average marked</span>
            </div>
          </div>
        )}

        {data.trend && (
          <p className="mt-4 text-[13px] text-ink-secondary">
            <span
              className="nums font-medium"
              style={{
                color:
                  data.trend.deltaPts <= -2
                    ? 'var(--bad)'
                    : data.trend.deltaPts >= 2
                      ? 'var(--good)'
                      : 'var(--ink)',
              }}
            >
              {data.trend.deltaPts >= 0 ? '+' : ''}
              {Math.round(data.trend.deltaPts)} pts
            </span>{' '}
            versus the previous 90 days (was {pct(data.trend.previousEffectiveness)}).
          </p>
        )}
      </div>

      {data.flags.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-hairline pt-5">
          {data.flags.map((f) => (
            <li key={f.kind} className="flex gap-2.5 text-[13px] leading-snug text-ink-secondary">
              <span aria-hidden style={{ color: 'var(--warn)' }}>
                &#9650;
              </span>
              {f.detail}
            </li>
          ))}
        </ul>
      )}

      {/* Split only at lg: at sm the two columns are too narrow for a label, a
          bar and a count to coexist, which collapsed the bars to zero width. */}
      {!compact && data.totals.decided > 0 && (
        <div className="mt-6 grid gap-7 border-t border-hairline pt-6 lg:grid-cols-2 lg:gap-10">
          <Breakdown title="By severity" buckets={data.bySeverity} />
          <Breakdown title="By area" buckets={data.byArea.slice(0, 7)} />
        </div>
      )}

      <details className="group mt-6 border-t border-hairline pt-4">
        <summary className="cursor-pointer text-[12px] text-ink-muted transition-colors hover:text-ink-secondary">
          What this measures, and where it is soft ({data.caveats.length})
        </summary>
        <ul className="mt-3 space-y-2.5">
          {data.caveats.map((c, i) => (
            <li key={i} className="max-w-[62ch] text-[12px] leading-relaxed text-ink-muted">
              {c}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
