# DiffHawk

**Is the AI code reviewer you already run actually working? DiffHawk measures it —
then quietly turns off the parts that aren't.**

> Status: in development. The measurement thesis behind it is already proven and
> public — see [the numbers](#the-numbers-this-is-built-on) below.

---

## The problem

Your team turned on an AI code reviewer months ago. It leaves comments on every
PR. Nobody knows if it's helping.

I measured this properly before building anything. Across **716 public
repositories and 15,000+ pull requests** ([AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census)):

- **~38%** of active repos run an AI reviewer.
- **Only 45%** of those reviewers' comments ever lead to a code change — versus
  **61%** for human comments.
- Most of the wasted comments cluster on predictable places: generated files,
  migrations, lockfiles.

So more than half of what your AI reviewer says changes nothing, and it's usually
noisy in the *same* spots — but no tool tells you which, and the vendor never
will, because it isn't a neutral party about its own value.

## What DiffHawk does

Three moves, on one engine:

1. **Measure.** Ingest your reviewer's comments and track what actually happened
   to each — did the code change, was it resolved, dismissed, ignored — attributed
   by file path, category, and severity. The core signal is git state, not an LLM
   guessing, so it's cheap and can't be gamed by wording.

2. **Report.** A per-repo, per-path scorecard:

   ```
   CodeRabbit on your-org/api · 90 days
     312 comments · 38% led to a code change · $0.11 / acted-on comment

     src/services/**      54% acted on   keep
     **/*.generated.ts     2% acted on   suppress  (47 comments, 1 change)
     migrations/**         0% acted on   suppress  (23 comments, 0 changes)
   ```

3. **Act.** Generate a `.diffhawk/policy.yml` that mutes the reviewer where it's
   historically noise and keeps it where it earns its place — proposed as a PR you
   merge, never applied silently. Measurement that changes behaviour.

DiffHawk keeps the tool you already pay for. It just makes it stop crying wolf, so
your team stops ignoring it.

## What it is not

- Not another reviewer competing on comment volume. It *measures* reviewers;
  being one is an optional, secondary component.
- Not a bot consolidator — the census showed only ~12% of teams run 2+ reviewers,
  so that product doesn't have a market.
- Not an approver or merger. It reads and measures; at most it posts a scorecard
  and opens a policy PR.

## The numbers this is built on

| | |
|---|---|
| Repositories studied | 716 (and growing) |
| Pull requests | 15,000+ |
| Run any AI reviewer | ~38% |
| Run 2+ | ~12% |
| AI comments that changed code | 45% |
| Human comments that changed code | 61% |

Full study, method, limitations, and raw data:
**[AI Code Review Census](https://github.com/AnishBplayz/ai-reviewer-census)**.

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
