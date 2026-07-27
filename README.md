# DiffHawk

**Is the AI code reviewer on your repo actually working? DiffHawk measures it,
compares it against a real baseline, and tells you when it degrades.**

[![tests](https://img.shields.io/badge/tests-47%20passing-brightgreen)](#verification)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![study](https://img.shields.io/badge/built%20on-1%2C112%20repos-informational)](https://github.com/AnishBplayz/ai-reviewer-census)

```
  Gemini on kubeedge/kubeedge  · 2026-04-28 → 2026-07-27

  65% of 26 decided comments led to a code change  (17 acted-on, 16 pending)
  census global for Gemini: 44%  — this repo is above average  ·  sharp — earning its place

  by severity
    critical     ████████░░░░░░░░   50%  2/4
    high         █████████████░░░   80%  4/5
    unknown      ██████████░░░░░░   65%  11/17
```

That output is real, from a live run. Everything below is measured, and where a
number is soft this README says so.

---

## The problem

Your team turned on an AI code reviewer months ago. It comments on every PR.
Nobody knows whether it's helping.

I measured that before building anything. Across **1,112 public repositories and
28,000+ pull requests** ([AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census), raw data included):

- **~38%** of active repos run an AI reviewer.
- Their comments lead to a code change **43%** of the time. **That average is
  the problem**, not the finding: per repo it ranges from **14% (p10) to 70%
  (p90)**, and **1 in 5 repos sit at ≤25%** — some at 0–3%, a reviewer doing
  effectively nothing.
- Those teams cannot tell, because the only number they have heard is the
  average.

The vendor will never tell them either. A reviewer vendor is not a neutral party
about its own value.

## What DiffHawk does

**1. Measures.** Reads your reviewer's comments and what became of each: did the
anchored code change, was the thread resolved, dismissed, or ignored. The signal
is git state, not a model's opinion, so it costs nothing and cannot be gamed by
how a comment is worded.

**2. Compares.** Your rate against the census baseline for that same reviewer, so
you learn whether the number is *good* — not just what it is.

**3. Flags.** Each window against the one before it. A reviewer that quietly got
worse after a model update is invisible from the outside and obvious in a trend.

## Try it

Requires [Bun](https://bun.sh). Read-only: it reads public pull requests and
writes nothing.

```bash
bun install
bun run score kubeedge/kubeedge     # a reviewer earning its place
bun run score <owner>/<repo>        # yours
```

Auth uses `GITHUB_TOKEN`, falling back to `gh auth token`.

### As a GitHub Action

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

It posts **one** scorecard comment and edits it in place forever after. A tool
that measures reviewer noise had better not generate any. Optional inputs:
`repo` (score a different repository and report here), `reviewer`, `days`,
`prs`, `post`.

<details>
<summary>Optional <code>.diffhawk.yml</code></summary>

```yaml
window_days: 90
reviewers: auto            # or [CodeRabbit, Copilot]
ignore: ["docs/**"]        # excluded from measurement
flags:
  degradation_drop_pts: 15 # flag a fall this large vs the previous window
report:
  post_scorecard: true     # false = job summary only
```
</details>

### Self-hosted, at fleet scale

```bash
cd deploy/docker && docker compose up -d --build
curl -X POST "localhost:3200/repos/OWNER/NAME/backfill?maxPages=5"
curl "localhost:3200/repos/OWNER/NAME/scorecard"
```

NestJS API + BullMQ workers + Postgres + Redis. Walking years of review history
is a genuine distributed job, which is why there's a queue rather than a cron.
See [deploy/docker/README.md](deploy/docker/README.md).

## How far to trust the number

This is the section most tools don't write.

"Acted on" means the code the comment points at changed afterwards. That is a
**proxy for influence, not proof of correctness**, and it is wrong in two known
directions: a rebase touching the same lines counts when it shouldn't, and a fix
made elsewhere in the file doesn't count when it should. Both are printed on
every scorecard, next to the number they affect.

I tried to validate that signal against an independent ground truth built from
commit history. **It failed** — the validation signal turned out noisier than the
thing it was validating, because of line drift across commits and a three-way
coordinate mismatch. So `isOutdated` is retained, the biases are documented, and
certification is deferred to a human-labelled set rather than faked. The full
accounting, including the numbers that look bad, is in **[EVAL.md](EVAL.md)**.

## What it is not

- **Not another reviewer.** It measures them. Being one is optional and last.
- **Not a bot consolidator.** The census killed that: only ~12% of repos run 2+
  reviewers and ~10% of their comments overlap.
- **Not an auto-muter.** An earlier design suppressed reviewers on "noisy" paths.
  The census killed that too — those paths are 0.8% of all comments because
  reviewers already skip them, and a comment nobody acted on is not proven
  wrong. It reports and flags; humans decide.

Three product ideas died to data before any of them was built. That is the
method, not an anecdote.

## Where competitors are ahead

- The reviewer vendors are far more polished, with deep IDE and CI integration.
- [Martian's Code Review Bench](https://codereview.withmartian.com/) is the
  established **global** benchmark. DiffHawk is the **per-repo** instrument. A
  global F1 score cannot tell you your reviewer is useless on *your* codebase.
- No whole-repo semantic index in v1, so cross-file architectural issues are
  missed. Stated plainly rather than overclaimed.

## Verification

Not "it should work" — what was actually run:

| Claim | How it was checked |
|---|---|
| Engine correctness | 47 tests, no network, fixtures |
| Exactly-once ingest | worker killed mid-backfill, resumed: **exactly 20 comments, not 25 or 30** |
| Under concurrency | 3 replicas, 3 simultaneous backfills of one repo: **221 → 221** |
| Webhook security | valid, replayed, bad signature, tampered body → 202, dedupe, 400, 400 |
| Graceful shutdown | `docker compose stop` → every replica **exit 0**, drained |
| The Action | run on this repo; posts a scorecard, then **updates it in place** |
| Cost | measured at **~64 GraphQL points per scoring**, which is why the demo caches |

## Design & docs

- [Positioning](docs/POSITIONING.md) — thesis, data, honest competitive position
- [Architecture](docs/ARCHITECTURE.md) — pipeline, systems layer, threat model
- [Roadmap](docs/ROADMAP.md) — phases, what's done, what isn't
- [Decisions](docs/DECISIONS.md) — ADRs, including the ones data reversed
- [EVAL.md](EVAL.md) — how far the core signal can be trusted

## License

Apache-2.0. Reads public pull requests; writes only a scorecard comment.
