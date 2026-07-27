import { ScoreForm } from './components/ScoreForm';

const CENSUS = 'https://github.com/AnishBplayz/ai-reviewer-census';

/** Real values from the census at n=1112. Nothing here is illustrative. */
const DIST = { p10: 14, median: 43, p90: 70, weakShare: 20 };

export default function Home() {
  return (
    <main className="mx-auto max-w-[1120px] px-5 sm:px-8">
      <nav className="flex h-16 items-center justify-between">
        <span className="text-[15px] font-medium tracking-tight">DiffHawk</span>
        <div className="flex items-center gap-5 text-[13px] text-ink-secondary">
          <a href={CENSUS} className="transition-colors hover:text-ink">
            The study
          </a>
          <a
            href="https://github.com/AnishBplayz/diffhawk"
            className="transition-colors hover:text-ink"
          >
            Source
          </a>
        </div>
      </nav>

      {/* Hero. Four text elements at most: headline, subtext, the form, one note. */}
      <section className="grid gap-10 pt-14 pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:gap-16 lg:pt-24">
        <div>
          <h1 className="max-w-[19ch] text-[40px] leading-[1.04] font-medium tracking-tight text-ink sm:text-[54px]">
            Your AI reviewer comments. Does anyone act on it?
          </h1>
          <p className="mt-5 max-w-[52ch] text-[16px] leading-relaxed text-ink-secondary">
            Paste a repository. DiffHawk reads its review history and measures how often those
            comments led to real code changes.
          </p>
          <div className="mt-8 max-w-[34rem]">
            <ScoreForm />
          </div>
        </div>

        {/* The finding that justifies the tool. Real percentiles, not decoration. */}
        <aside className="lg:pt-3">
          <p className="max-w-[34ch] text-[13px] leading-relaxed text-ink-secondary">
            Across {'1,112'} repositories, an AI reviewer&apos;s comments led to a code change{' '}
            <span className="nums text-ink">43%</span> of the time on average. That average hides
            almost everything.
          </p>

          <div className="mt-6">
            <div className="relative h-[3px] rounded-full bg-hairline">
              {[DIST.p10, DIST.median, DIST.p90].map((p) => (
                <span
                  key={p}
                  className="absolute -top-[5px] h-[13px] w-[2px] rounded-full"
                  style={{ left: `${p}%`, background: 'var(--accent)' }}
                  aria-hidden
                />
              ))}
            </div>
            <div className="nums mt-2.5 flex justify-between text-[11px] text-ink-muted">
              <span>{DIST.p10}%</span>
              <span>{DIST.median}%</span>
              <span>{DIST.p90}%</span>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
              10th percentile, median, 90th percentile
            </p>
          </div>

          <p className="mt-6 max-w-[34ch] text-[13px] leading-relaxed text-ink-secondary">
            <span className="nums text-ink">{DIST.weakShare}%</span> of repositories run a reviewer
            that is acted on a quarter of the time or less. Some sit near zero. Their teams cannot
            tell, because the only number they have heard is the average.
          </p>
        </aside>
      </section>

      {/* Different layout family: a horizontal band of plain statements, no cards. */}
      <section className="grid gap-8 border-y border-hairline py-12 sm:grid-cols-3 sm:gap-10">
        <div>
          <h2 className="text-[14px] font-medium text-ink">Measured from git, not guessed</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            A comment counts when the code it points at actually changed. No model judges the
            result, so wording cannot game it.
          </p>
        </div>
        <div>
          <h2 className="text-[14px] font-medium text-ink">Compared to a real baseline</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            Your rate is shown against the global rate for that same reviewer, so you learn whether
            the number is good, not just what it is.
          </p>
        </div>
        <div>
          <h2 className="text-[14px] font-medium text-ink">Watches for decay</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
            Each window is compared with the one before it. A reviewer that quietly got worse after
            a model update shows up as a drop.
          </p>
        </div>
      </section>

      {/* Editorial, narrow measure. The honesty section is the whole pitch. */}
      <section className="max-w-[64ch] py-16">
        <h2 className="text-[26px] leading-tight font-medium tracking-tight text-ink sm:text-[32px]">
          What this does not claim
        </h2>
        <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-ink-secondary">
          <p>
            &ldquo;Acted on&rdquo; means the anchored code changed after the comment. That is a
            proxy for influence, not proof of correctness. A rebase touching the same lines counts
            when it should not, and a fix made elsewhere in the file does not count when it should.
            Both directions are known and both are printed on every scorecard.
          </p>
          <p>
            An earlier version of this tool was going to mute reviewers automatically on paths where
            they looked noisy. The study killed that: those paths are under one percent of all
            comments, because reviewers already skip them. A comment that nobody acted on is also
            not proven wrong, so muting on that signal would hide real findings.
          </p>
          <p>
            So DiffHawk reports and flags. It does not decide for you.{' '}
            <a
              href={CENSUS}
              className="text-ink underline decoration-hairline-strong underline-offset-2 transition-colors hover:decoration-ink"
            >
              The full study, its method, and its raw data are public.
            </a>
          </p>
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline py-8 text-[12px] text-ink-muted">
        <span>Apache-2.0. Reads public pull requests only, and writes nothing.</span>
        <a href={CENSUS} className="transition-colors hover:text-ink-secondary">
          AI Code Review Census
        </a>
      </footer>
    </main>
  );
}
