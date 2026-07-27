# DiffHawk — Build Order, Workflow, and Launch

Ordered so something demonstrable exists at the end of every phase, and so the
risky/novel parts are proven before infrastructure is built around them. The
riskiest assumption — "do teams run AI reviewers whose comments get ignored?" —
is **already retired** by the [Census](https://github.com/AnishBplayz/ai-reviewer-census).
That's why Phase 0 starts from working code, not a blank repo.

Durations assume evenings-and-weekends, not full-time.

---

## Phase 0 — Engine + CLI · "it scores a real repo" · ~4–5 days

Promote the census scanner into a product engine. The bot registry, GraphQL
ingest, and the `isOutdated` action proxy already exist and are tested — this
phase re-homes them behind clean ports and adds effectiveness scoring.

- [ ] npm workspace, TS strict, Vitest, lint; `packages/core` + `packages/ingest`
- [ ] Port the census registry + ingest; add `VcsProvider` / `ReviewStore` ports
- [ ] OUTCOME stage: acted-on / resolved / dismissed / ignored, each with evidence
- [ ] ATTRIBUTE stage: bucket outcomes by severity and coarse area
- [ ] SCORE stage: per-repo effectiveness, per-severity/area breakdown
- [ ] `apps/cli`: `diffhawk score owner/repo` → scorecard in the terminal
- [ ] Zod schemas: `ReviewComment`, `Outcome`, `Scorecard` (with `caveats`)

**Exit gate:** run it on 10 real repos that run a reviewer (yours + OSS from the
census corpus — the targets are already known). It produces a per-repo scorecard
that correctly separates a sharp reviewer from a near-noise one (the census says
~1 in 5 will be the latter). Screenshot the starkest one; that image is the launch
asset.

---

## Phase 1 — Trust the number · "the scorecard is honest" · done

The scorecard is only as good as the outcome signal. Harden it, and find out how
far it can actually be trusted.

- [x] Refine the outcome model: `pending` (open PRs) excluded from the rate
      instead of counted as failures; `merged` vs `closed_unmerged` distinguished
      so an abandoned PR doesn't read like a merged one; evidence recorded per
      outcome
- [x] `packages/eval`: build a ground truth *independent* of `isOutdated` from
      post-comment commit diffs, freeze it to a corpus, score `isOutdated` against
      it, and re-score offline
- [x] Publish the result honestly in [`EVAL.md`](../EVAL.md)
- [x] Attach the confirmed biases (inflation, deflation, unmerged, pending) to
      every scorecard's `caveats` at runtime

**Outcome — an honest negative, and the more useful result.** The plan was to hit
≥90% agreement with a gold set. Instead the investigation showed that the cheap
automated ground truth is *less* reliable than `isOutdated` itself — line-number
drift across commits and a three-way coordinate mismatch (HEAD line vs diff
position vs per-commit patch line) make commit-overlap noisier than the signal it
was checking, proven by hand-verifying the disagreements. So `isOutdated` is
retained, its biases are documented on every number, and true certification is
deferred to a **human-labelled** gold set — which the harness is already built to
score against. The gate is not claimed as met, because it isn't, and faking it
would defeat the entire premise. That candor *is* the phase earning the word
"measured."

---

## Phase 2 — GitHub Action + Flags · "it watches over time" · done

Ship the low-friction surface and the trend/degradation signal.

- [x] `action.yml` composite Action + `apps/action` entrypoint; posts via
      `GITHUB_TOKEN`, writes the job summary, never fails the build on a post error
- [x] `.diffhawk.yml` parse + defaults (`packages/config`), snake_case tolerant,
      loud on invalid values instead of silently defaulting
- [x] **Real window filtering** — until now `window` was only a label and scoring
      used the whole fetch, conflating "last 90 days" with "the last N PRs"
- [x] Trend + degradation: compare each window against the equal-length one
      before it, flag material drops, suppress the flag on thin samples
- [x] Idempotent scorecard comments via a hidden marker (no duplicate walls)
- [x] `.github/workflows/diffhawk.yml` — dogfood workflow, weekly + per-PR

**Two bugs the live smoke test caught, both worth recording:**

1. **A verdict invented from nothing.** With every recent PR still open, the
   scorecard rendered `0% · noise — barely acted on`. Zero decided comments is
   *insufficient data*, not a bad reviewer. Added an `insufficient` verdict below
   10 decided comments, and suppressed the "below average" comparison with it.
2. **Discarding decided successes.** Phase 1 marked every open-PR comment
   `pending`, including ones whose code had *already* changed — an observed fact a
   later merge cannot undo. On one real repo that hid 76 of 90 comments and
   dropped the sample below any verdict at all. Now: already-changed counts,
   only genuinely-untouched-and-open pends. The same repo went from
   "29% of 14 decided" to "81% of 54 decided".

**Validated, not assumed:** the degradation threshold could have been confounded
by comment age, so it was measured against the census — outdated-rate moves ~4 pts
from the first week to 7–90 days and then *declines*, non-monotonically. It cannot
manufacture a false degradation, and the 15pt default sits clear of it. Written up
in [`EVAL.md`](../EVAL.md).

> **Not in this phase, on purpose:** automatic path-based suppression. The census
> showed noise is not path-separable (generated/lock/migration paths are 0.8% of
> comments and reviewers already skip them), and an un-acted-on comment isn't
> proven wrong — so auto-muting would hide real findings. DiffHawk reports and
> flags; a human decides. A narrow, evidence-gated auto-policy stays a research
> item until the scorecard can justify one.

**Exit gate:** a ≤10-line workflow gives a working scorecard on a fresh repo, and
a simulated effectiveness drop across two windows raises a degradation flag.

---

## Phase 3 — The systems layer · "it backfills a fleet" · ~7–9 days

The job-gap phase. Everything the original idea wanted, now with a real reason:
**history backfill is the distributed job.**

- [ ] `packages/db` — Drizzle schema, migrations, `ReviewStore`
- [ ] `apps/api` — NestJS + Fastify; webhook verify → dedupe → persist → enqueue → 202
- [ ] GitHub App registration, install flow, per-install token minting
- [ ] `apps/worker` — BullMQ stages: `backfill.page`, `ingest`, `outcome`, `score`
- [ ] Resumable paginated backfill; checkpoint per page in Postgres
- [ ] Retries: backoff + jitter, Retry-After aware, shared Redis token bucket
- [ ] DLQ after N attempts with full stage input; replay endpoint
- [ ] Idempotency: delivery id + comment hash + scorecard window
- [ ] Graceful shutdown; lease release on SIGTERM
- [ ] Docker Compose: api + worker + redis + postgres, one command
- [ ] Testcontainers integration tests, incl. **deliberate failure injection**

**Exit gate:** kill a worker mid-backfill. It resumes and completes exactly once —
no double-counted comments in the scorecard. Write that chaos test; it is the
proof the phase is real, and the best interview story in the project.

---

## Phase 4 — Production posture · ~4–5 days

- [ ] K8s: API Deployment + Service + HPA; worker Deployment + KEDA on queue depth
- [ ] PDB, resource limits, probes, `terminationGracePeriodSeconds`
- [ ] Kustomize `base/` + overlays `{dev,prod}`; sealed-secrets reference
- [ ] `deploy/k8s/README.md` — the scaling rationale: why API and worker scale
      separately, what a Redis flush costs (nothing durable), how backfill
      backpressure works
- [ ] OTel traces spanning webhook → queue → stage → GitHub call
- [ ] Prometheus metrics: queue depth, backfill progress, stage latency, DLQ size,
      API points spent
- [ ] Grafana dashboard JSON in-repo; distroless non-root images; Trivy in CI

**Exit gate:** a Grafana screenshot under a synthetic 50-repo backfill in the
README, with the numbers.

---

## Phase 5 — Dashboard + trends · ~5–6 days

- [ ] `apps/web` — scorecards, per-severity/area drilldown, effectiveness **trend
      over time**, degradation flags, DLQ + replay
- [ ] Trend alerting: flag when a reviewer's effectiveness drops after a model
      change (a genuinely useful, genuinely novel signal)
- [ ] **CI scoring-regression gate:** a change that alters scores on the fixture
      corpus without an explained reason fails the build
- [ ] Public `EVAL.md`: outcome-classification accuracy, updated by CI

The trend view is what turns a snapshot into a system: "your reviewer got 15%
noisier the week they shipped a new model" is a sentence no vendor will ever tell
a customer.

---

## Phase 6 — DiffHawk's own reviewer, on the Census · ~1–2 weeks

Only now, and only because everything above earns the right to.

- [ ] The precision pipeline: failure-scenario requirement → AST grounding →
      adversarial refutation → hard comment cap
- [ ] Enter it **publicly on the Census**, scored by the same neutral tool as
      every competitor, losses shown
- [ ] Blog: *"I built an AI reviewer, then scored it with the benchmark I built —
      here's where it loses."*

Shipping a reviewer this way — measured by your own public, neutral instrument,
weaknesses first — is far more credible than shipping one with a self-benchmark.
It is also the cleanest possible answer to "why trust DiffHawk's numbers."

---

## Engineering workflow

**Branching** — trunk-based, short-lived branches, squash merge, Conventional
Commits (feeds changelog + semver via changesets). **No `Co-Authored-By` trailers**
— these are Anish's portfolio repos and the history reads as his own work.

**Every PR gets:** typecheck, lint, unit, integration (Testcontainers), injection
canaries, the scoring-regression gate (Phase 5+), and a DiffHawk scorecard of the
repo itself (Phase 2+).

**The outcome signal is code, and it is tested like code.** Its behaviour on
force-push, squash, and rebase is pinned by fixtures. A change to it that moves
scores must explain why.

**Definition of done:** tested, documented, observable (a metric or log line),
failure-mode considered. Not "works on my machine."

**Cost discipline:** the `api_calls` ledger records every GitHub call. Backfill
cost per repo is always a known number.

---

## Launch plan

**Do not launch the product before Phase 4.** But the Census is *already public*
and is the warm-up act — it seeds the audience months ahead.

### Pre-launch checklist

- [ ] README: a real scorecard screenshot in the first screen, above the fold
- [ ] 30-second path (`npx diffhawk score`) verified on a clean machine
- [ ] 2-minute path (the Action) documented
- [ ] Honest comparison table, including where competitors win
- [ ] `EVAL.md` with real outcome-classification accuracy
- [ ] Public dogfooding: DiffHawk's own reviewer scored on the Census
- [ ] 8–10 seeded `good first issue`s (new reviewer adapters, new LLM adapters,
      new language grammars — self-contained and genuinely wanted)
- [ ] CONTRIBUTING, CODE_OF_CONDUCT, LICENSE (Apache-2.0), SECURITY + threat model

### Launch sequence

| When | Where | Angle |
|---|---|---|
| Day 1, Tue–Thu ~08:00 ET | **Show HN** | *"Show HN: DiffHawk — find out if the AI code reviewer you already pay for is actually working"* — lead with the ignored-comment number from the Census. |
| Day 1 | Lobste.rs, r/programming, r/devops, r/selfhosted | Self-hosting + neutrality angle. |
| Day 2 | dev.to / Hashnode | *"I measured 813 repos to find out if AI code review works. Then I built the tool that measures yours."* — the Census → product arc is the story. |
| Day 3–7 | X/Bluesky | The per-path scorecard screenshot is the hook. |
| Week 2 | awesome-* PRs, dev-tool Discords | Long tail. |

### What converts a visitor to a star

In order: a screenshot showing the tool being *useful* on a real repo → a
try-path with no signup → a README that admits limits → visible recent activity
(the Census already provides this) → seeded issues. Stars follow usefulness; none
of this is a growth hack.

### The résumé lines this earns

From Phase 4, all true and each a ten-minute interview thread:

- Designed a distributed history-backfill system — NestJS API, BullMQ workers,
  Redis transport, Postgres as source of truth, independently scaled on K8s via
  KEDA — that walks years of GitHub PR history under strict rate limits.
- Built exactly-once measurement under retry, force-push, and squash-merge, proven
  by a chaos test that kills workers mid-backfill.
- Designed rate-limit-aware backoff with a Redis-shared token bucket across worker
  replicas.
- Shipped the measurement thesis as a public 813-repo study *before* building the
  product, and let the data kill a feature (bot consolidation) before it was built.
- Wrote the threat model for a system whose every input is attacker-controlled.
- Gated scoring changes in CI on a fixture-corpus regression check.

That last-but-one line — killing your own idea with data — is the one most
candidates can't tell, and the one interviewers remember.
