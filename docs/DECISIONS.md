# DiffHawk — Decision Log

Short ADRs: the call, the alternatives, and what would reverse it. Kept current —
a decision log that stops matching the code is worse than none.

---

## ADR-001 · Measure the market before building the product

**Decision.** Build the [AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census) first — a 813-repo
study of AI reviewer behaviour — and let its results set the product direction.

**Why.** The original idea (build another reviewer) and the first pivot (build a
multi-bot consolidator) were both plausible and both wrong for reasons only data
could show. The census cost a few days and killed the consolidator before a line
of it was written: only ~12% of repos run 2+ reviewers, only ~10% of their
comments collide.

**Consequence.** Every headline claim in POSITIONING traces to a measured number,
not a hunch. This is the project's spine and its single strongest portfolio
signal.

**Reverse if.** Never. Even a wrong prediction validated cheaply is a win.

---

## ADR-002 · Target the single-reviewer majority, not the multi-reviewer edge

**Decision.** Build for the ~38% of repos running exactly one AI reviewer, whose
comments are ignored more than half the time (44% acted-on vs 60% for humans).

**Alternatives.** Consolidate multiple bots (the killed pivot); build a better
reviewer (commodity, incumbents win on distribution).

**Why.** It is the largest population the census found and the one with an
unmet, unmeasured need. The consolidator served a population 3× smaller with a
problem that barely exists.

**Reverse if.** Multi-reviewer adoption crosses ~25% and duplication ~25% in the
census, which is tracked continuously. Both have been flat across n=120→813.

---

## ADR-003 · The core signal is git state, not model judgement

**Decision.** "Did this comment lead to a code change?" is answered by GitHub's
`isOutdated` flag and thread state — deterministic, no LLM. Text is used only for
optional categorisation, which never gates a number.

**Why.** A measurement product must be trustworthy and cheap to recompute. A
git-derived signal cannot be gamed by comment wording, costs no tokens, and is
replayable offline. The census validated it across 22,000+ PRs.

**Cost accepted.** `isOutdated` is a proxy with known biases (force-push, squash,
unrelated same-region edits). These are documented in every scorecard's `caveats`
and measured for accuracy in `EVAL.md` — not hidden.

**Reverse if.** Outcome-classification accuracy against human labels falls below
usefulness and no cheap correction restores it.

---

## ADR-004 · One engine, three surfaces (CLI, Action, App)

**Decision.** The scoring engine is a pure, I/O-free library. CLI, Action, and
self-hosted App are thin adapters over it.

**Why.** The CLI makes trying it free (the funnel), the Action makes adopting it
free (the habit), the App makes the systems engineering real (the job story). One
scoring codebase, testable with zero I/O — the only way the scoring-regression
gate is feasible.

**Reverse if.** Port abstractions start leaking transport concerns into core.

---

## ADR-005 · Postgres is the source of truth; Redis is transport

**Decision.** Durable measurement state — comments, outcomes, scorecards, the
API-call ledger — lives in Postgres. Redis holds only in-flight queue state.

**Why.** For a measurement product, the record *is* the product. Scorecards,
trends, and regression tests are relational queries over history. A double-counted
comment is a wrong number, so idempotency and durability are correctness
requirements, not niceties. Losing the record to a cache eviction is an unforced
error with a bad interview answer.

---

## ADR-006 · The model never takes an action; policy is deterministic code

**Decision.** Any LLM use (categoriser, optional own-reviewer) emits structured
data validated by Zod. Turning a scorecard into a policy file or a PR is
deterministic code. The model has no side-effecting tools.

**Why.** DiffHawk reads attacker-controlled diffs and comments. If the model can't
act, injection can at worst degrade a categorisation — never change what DiffHawk
does to your repo. Enforced by canary tests. Permanent constraint.

---

## ADR-007 · Backfill is the distributed job; the queue is not decoration

**Decision.** The self-hosted App exists to backfill years of PR/comment history —
a resumable, rate-limited, exactly-once distributed job — and that is what
justifies BullMQ, retries, DLQ, and independent worker scaling.

**Why.** The original "webhook → one LLM call" barely needs a queue. A history
walk of thousands of API calls under secondary rate limits genuinely does. This
makes the systems layer honest rather than resume-driven ornamentation.

**Reverse if.** Real usage shows repos small enough that synchronous scoring
suffices — then keep the queue for the fleet case and document the threshold.

---

## ADR-008 · Report and flag; do not auto-suppress (revised on evidence)

**Decision.** DiffHawk measures the reviewer you run, reports a per-repo scorecard,
and flags degradation or bottom-decile performance. It does **not** automatically
mute comments.

**What changed.** An earlier version of this ADR had DiffHawk generate a
`.diffhawk/policy.yml` that suppressed the reviewer on paths where it was
historically noise. Before building it, a census sub-analysis tested the premise
and it failed on two counts:
1. **Noise is not path-separable.** Generated/lockfile/migration paths are 0.8% of
   all AI comments — reviewers already skip them. Ignored comments are spread
   across ordinary source.
2. **Un-acted-on ≠ wrong.** A correct nitpick a team declines to fix is
   indistinguishable from noise by the action proxy, so auto-muting on that signal
   would suppress real findings.

**Why the new shape.** The measurable, defensible value is *visibility*: the
census shows per-repo effectiveness ranges 13%–69%, and ~19% of repos run a
reviewer at ≤25% without knowing it. Surfacing that number, its trend, and its
percentile is real and honest. Acting on it is the human's call.

**Reverse if.** The scorecard produces a narrow, high-confidence, evidence-gated
rule (e.g. one reviewer's `low`-severity comments in an area proven near-zero over
a long window) — then offer it behind explicit per-repo opt-in, logged and
reversible. Not before the data earns it.

**Note.** This is the third idea the census killed or reshaped before code
(after "another reviewer" and "the consolidator"). That the measurement layer
keeps overruling the product intuition is the strongest evidence the measurement
layer is worth having — and the story worth telling.

---

## ADR-009 · No `Co-Authored-By` trailers in commit history

**Decision.** Commits in DiffHawk (and the census) carry no AI co-author trailer.

**Why.** These are Anish's portfolio and job-search artifacts; the history should
read as his own work. Applied from the start here to avoid a history rewrite like
the one the census needed.

---

## ADR-010 · No whole-repo semantic index in v1

**Decision.** Attribution uses severity, coarse path areas, and the diff — no
embedding index or vector store.

**Why.** A repo-wide index is a large subsystem where funded competitors have a
structural edge a solo build won't match. Scoring effectiveness by severity and
area needs none of it. The README states the limitation plainly.

**Reverse if.** A high-value signal proves unreachable without cross-file context
— then add targeted call-graph lookup, not a general index.

---

## ADR-011 · Apache-2.0 for code; the Census data stays CC BY 4.0

**Decision.** DiffHawk code is Apache-2.0 (patent grant matters to the corporate
legal reviews that gate self-hosting adoption). The census dataset remains CC BY
4.0 so anyone citing its numbers must attribute.

**Why.** Attribution-required data maximises Anish's visibility (the explicit
goal) while keeping the numbers reproducible; permissive code maximises adoption.

---

## ADR-012 · Naming and voice

`DiffHawk` — verified unclaimed on GitHub, npm, and general web search
(2026-07-23). A hawk watches; now it watches your reviewer. **Claim `diffhawk` on
npm and the GitHub org before any public launch** — squatting after a Show HN is a
real, avoidable loss. Voice: precise, understated, willing to state limitations —
the product's whole claim is honest measurement, so the marketing must not
overclaim.
