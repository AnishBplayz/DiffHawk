# DiffHawk

**Is the AI code reviewer you already run actually working? DiffHawk measures it,
compares it to a real baseline, and tells you when it degrades.**

> Status: in development. The measurement thesis behind it is already proven and
> public — see [the numbers](#the-numbers-this-is-built-on) below.

---

## The problem

Your team turned on an AI code reviewer months ago. It leaves comments on every
PR. Nobody knows if it's helping.

I measured this properly before building anything. Across **1,112 public
repositories and 28,000+ pull requests** ([AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census)):

- **~38%** of active repos run an AI reviewer.
- Their comments lead to a code change **44%** of the time — but that average is a
  lie. Broken out per repo it runs from **13% (p10) to 69% (p90)**, and **~1 in 5
  repos sit at ≤25%** — some at 0–3%, a reviewer doing effectively nothing.
- The teams running those failing reviewers can't tell, because the only number
  they've heard is the global average.

So the question "is the AI reviewer on *my* repo actually working?" has a real,
wildly-varying answer that nobody measures — and the vendor never will, because it
isn't a neutral party about its own value.

## What DiffHawk does

1. **Measure.** Ingest your reviewer's comments and track what actually happened
   to each — did the code change, was it resolved, dismissed, ignored — broken out
   by severity and area. The core signal is git state, not an LLM guessing, so
   it's cheap and can't be gamed by wording.

2. **Report.** A per-repo scorecard that answers *is this reviewer working here?*:

   ```
   CodeRabbit on your-org/api · 90 days
     312 comments · 18% led to a code change · $0.31 / acted-on comment
     Global average is 37%. On your repo it's half that — bottom ~15%.

     by severity     acted on
       high             41%     the useful part
       medium           14%
       low / nitpick     4%     60% of the volume, ~none of the value
   ```

3. **Flag.** Track the number over time and raise it when the reviewer degrades
   (a drop from 45% to 20% after a model change is invisible from the outside) or
   when it simply isn't earning its place — with a number behind the decision to
   tune or drop it, instead of a vibe.

DiffHawk keeps the tool you already pay for. It just tells you the truth about
whether it works — which, for one repo in five, is "it doesn't, and you didn't
know."

> **Honesty note:** an earlier draft of this README claimed the noise clusters on
> generated files and lockfiles and that DiffHawk would auto-suppress it there.
> The census disproved it — those paths are 0.8% of all AI comments; reviewers
> already skip them. The ignored comments are spread across real source code. The
> pitch above is what the data actually supports. Measuring first is the whole
> point of this project, so the docs follow the measurements even when it's
> inconvenient.

## What it is not

- Not another reviewer competing on comment volume. It *measures* reviewers;
  being one is an optional, secondary component.
- Not a bot consolidator — the census showed only ~12% of teams run 2+ reviewers,
  so that product doesn't have a market.
- Not an auto-muter or merger. It reads, measures, and recommends; humans decide.

## The numbers this is built on

| | |
|---|---|
| Repositories studied | 1,112 (and growing) |
| Pull requests | 28,000+ |
| Run any AI reviewer | ~38% |
| Run 2+ | ~12% |
| AI comments that changed code (average) | 44% |
| …per-repo range (p10–p90) | 13% – 69% |
| Repos where the reviewer is acted on ≤25% | ~19% |

Full study, method, limitations, and raw data:
**[AI Code Review Census](https://github.com/AnishBplayz/ai-reviewer-census)**.

## Try it (Phase 0 — the scoring engine + CLI)

Requires [Bun](https://bun.sh). Read-only; it only reads public pull requests and
uses `GITHUB_TOKEN` or falls back to `gh auth token`.

```bash
bun install
bun run score maximhq/bifrost        # a reviewer that's earning its place (~68%)
bun run score <owner>/<repo>          # your repo
```

Sample output:

```
  CodeRabbit on maximhq/bifrost  · 2026-04-24 → 2026-07-23

  68% of 130 comments led to a code change  (89 acted-on)
  census global for CodeRabbit: 37%  — this repo is above average  ·  sharp — earning its place

  by severity
    high         ████████████████   97%  65/67
    unknown      ██████░░░░░░░░░░   35%  19/54
  ...
```

The census makes the comparison possible: `bun run score` knows the global
per-reviewer baseline, so it can tell you not just *your* number but whether it's
good. Run it on a few repos and you'll see the same 25%–70% spread the census
found — that variance, per repo, is the whole point.

`bun test` runs the pure-engine suite (outcome classification, severity
inference, diff parsing, and the full scoring pipeline against fixtures — no
network).

## Run it on your repo (GitHub Action)

Drop this in `.github/workflows/diffhawk.yml`. No server, no signup, no API key —
it uses the built-in `GITHUB_TOKEN`:

```yaml
name: DiffHawk scorecard
on:
  schedule: [{ cron: "23 6 * * 1" }]   # weekly
  pull_request:
permissions: { contents: read, issues: write, pull-requests: write }
jobs:
  scorecard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: AnishBplayz/DiffHawk@main
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

It posts **one** scorecard comment and edits it in place on every later run —
never a wall of duplicates. (A tool that measures reviewer noise had better not
generate any.) The scorecard also lands in the workflow's job summary.

Optional `.diffhawk.yml`:

```yaml
window_days: 90
reviewers: auto            # or [CodeRabbit, Copilot]
ignore: ["docs/**"]        # excluded from measurement
flags:
  degradation_drop_pts: 15 # flag a fall this large vs the previous window
report:
  post_scorecard: true     # false = job summary only
```

**Trend detection** compares each window against the one before it, so a reviewer
that quietly got worse after a model update shows up as
`📉 −22 pts (was 51%)` — something no vendor dashboard will tell you.

**How far to trust the number:** the effectiveness rate rests on GitHub's
`isOutdated` signal. [`EVAL.md`](EVAL.md) is the honest accounting — including the
part where an attempt to validate it against commit history revealed that the
*validation* signal was noisier than `isOutdated` itself, so certification is
deferred to a human-labelled gold set rather than faked. The confirmed biases ride
along on every scorecard's caveats.

## Where competitors are ahead

Honest, because it's the fast way to earn trust:

- The reviewer vendors are far more polished and have deep IDE/CI integration.
- [Martian's Code Review Bench](https://codereview.withmartian.com/) is the
  established *global* benchmark — DiffHawk is the *per-repo* instrument, a
  different job.
- DiffHawk has no whole-repo semantic index in v1, so it will miss cross-file
  architectural issues. Stated plainly rather than overclaimed.

## Design & docs

- [Positioning](docs/POSITIONING.md) — the thesis, the data, competitive position
- [Architecture](docs/ARCHITECTURE.md) — the engine, the systems layer, threat model
- [Roadmap](docs/ROADMAP.md) — phased build order, launch, résumé lines
- [Decisions](docs/DECISIONS.md) — ADRs, including the ones the data reversed

## License

Apache-2.0.
