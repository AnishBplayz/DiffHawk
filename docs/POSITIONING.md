# DiffHawk — Positioning

## The one-line claim

> **DiffHawk tells you whether the AI code reviewer you already run is actually
> earning its place — and quietly turns off the parts that aren't.**

## This claim is not a guess. It was measured first.

Before writing a line of the product, I built [AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census) — a study of AI code
reviewer behaviour across **716 public repositories and 15,000+ pull requests**.
Three numbers from it define this entire project:

| Finding | Value | What it means for the product |
|---|---|---|
| Repos running **any** AI reviewer | **~38%** | The market is real and large. |
| Repos running **2 or more** | **~12%** | Nobody is drowning in competing bots. |
| Cross-vendor **duplicate rate** | **~10%** | The bots that coexist rarely collide. |
| AI comments that **led to a code change** | **45%** | **Over half of AI review comments change nothing.** |
| The same rate for **human** comments | **61%** | The gap is real and stable across the whole sample. |

The last two rows are the product. **A reviewer whose comments are ignored more
than half the time is running on every one of those ~38% of repositories, and
nobody is measuring whether it is worth keeping.**

## What died, and why that's good

An earlier version of this plan was going to *consolidate* multiple noisy bots
into one clean thread — a router. The census killed it: only 12% of repos run
two reviewers and only 10% of their comments overlap. Building a consolidator
for a problem 88% of teams don't have would have been a confident, well-engineered
mistake. **Measuring first is what stopped it** — and that story, "I killed my own
idea with my own data before building it," is itself part of the portfolio.

What survived is sharper and aimed at the population that actually exists.

## The problem DiffHawk owns

Teams adopt an AI reviewer on a vibe and keep it on a vibe. Six months later:

- Nobody knows its true hit rate on *their* codebase.
- Nobody knows it wastes everyone's attention on `migrations/`, `*.generated.*`,
  and lockfiles while being genuinely sharp on business logic.
- Nobody can put a number on "is the $30/dev/month — or the review latency —
  worth it?"
- The vendor's own dashboard will never tell them, because the vendor is not a
  neutral party about its own value.

The census proves this at population scale. DiffHawk brings the same measurement
down to a single team's repository and then acts on it.

## What DiffHawk does — three moves on one engine

### 1. Measure — the Referee

Ingest every comment your existing reviewer leaves (CodeRabbit, Copilot, Cursor,
Codex, Gemini, Greptile — whichever one you run) and track what actually happened
to each: did the anchored code change, was the thread resolved, was it dismissed,
was it ignored. Attribute every outcome by **file path, comment category, and
severity**.

The core signal needs no LLM. "Did the code at these lines change after the
comment?" is answered by git, deterministically — the exact method the census
already validated across 15,000 PRs.

### 2. Report — the Scorecard

A per-repo, per-path effectiveness picture, updated on every PR:

```
CodeRabbit on your-org/api  ·  last 90 days

  312 comments   ·   38% led to a code change   ·   $0.11 / acted-on comment

  by path
    src/services/**      54% acted on   ← keep, it's sharp here
    src/routes/**        41% acted on
    **/*.generated.ts     2% acted on   ← 47 comments, 1 change: noise
    migrations/**         0% acted on   ← 23 comments, 0 changes: noise
    pnpm-lock.yaml        0% acted on

  63% of comments on generated/lockfiles. 3% of the value.
```

Nobody publishes this number for the tool you run. The vendor is incentivised not
to. That's the wedge.

### 3. Act — the Policy

The scorecard writes a `.diffhawk/policy.yml` from the data: mute the reviewer on
paths where it has historically been noise, keep it where it earns its place. This
is **measurement that changes behaviour** — the piece with teeth, and the piece no
analytics dashboard bothers to close.

A reviewer that stops commenting on your generated code is a reviewer your team
stops muting. That is how DiffHawk keeps a tool *alive* instead of replacing it.

## Optional, and deliberately last: DiffHawk's own reviewer

DiffHawk can also *be* a reviewer — a precision-first pipeline (every finding must
carry a falsifiable failure scenario, ground against the real AST, and survive
adversarial refutation). But this is a late, optional component, and it is entered
**publicly on the Census leaderboard, where it can lose.** Shipping your own
reviewer and scoring it with the same neutral tool you scored everyone else's is
the most credible way to ship one. That is the answer to "why should I trust your
measurements?" — because you pointed them at yourself first.

## Why the incumbents structurally cannot do this

- **A vendor cannot neutrally grade its own value.** CodeRabbit will never ship
  "here's how often our comments are ignored on your repo." The referee cannot be
  a player — a permanent conflict of interest, not a temporary lead.
- **Every new AI reviewer makes DiffHawk more useful, not less.** It is long the
  trend instead of fighting it.
- **It is neutral infrastructure.** A vendor that scores well will happily point
  its customers at it — distribution from the very tools it measures.

## Honest competitive position

| | DiffHawk | The reviewer vendors | Martian Census | LinearB / Swarmia |
|---|---|---|---|---|
| Grades the reviewer *you* run, on *your* repo | ✅ core | ❌ own output only | ❌ global only | ❌ no code-level AI signal |
| Neutral (not a reviewer vendor) | ✅ | ❌ | ✅ | ✅ |
| Acts on the finding (policy/suppression) | ✅ | partial | ❌ | ❌ |
| Self-hosted / bring-your-own-key | ✅ | enterprise tier | ❌ | ❌ |
| Whole-repo semantic index | ❌ not v1 | ✅ | — | — |
| Polish, integrations, maturity | behind | ahead | — | ahead |

Where they win, the README says so. A comparison table that admits what the tool
is worse at is the fastest way to earn an engineer's trust — and it pre-empts the
top HN comment.

## Who this is for

| Segment | Why they care |
|---|---|
| The ~38% of teams running exactly one AI reviewer | The entire pitch. They have the tool and no idea if it works. |
| Eng leads justifying (or cutting) an AI-review spend | A defensible per-repo number instead of a vibe. |
| Teams that muted their reviewer months ago | Turn it back on, scoped to where it's actually good. |
| Self-hosting / regulated orgs | Neutral, on-prem, code never leaves their infra. |

## What DiffHawk is *not*

- **Not another reviewer competing on volume.** It measures reviewers; being one
  is optional and secondary.
- **Not a consolidator.** The census killed that; only 12% of teams run 2+.
- **Not a vendor benchmark.** The Census is the global benchmark. DiffHawk is the
  per-repo instrument. Different jobs, shared engine.
- **Not an approver or merger.** It reads, measures, and at most posts a scorecard
  and adjusts a policy file. It never merges or writes code.

## Success criteria, in order

1. It runs on Anish's own repos and produces a scorecard he acts on.
2. Its own repo publicly dogfoods it, and the Census publicly scores DiffHawk's
   reviewer alongside everyone else's — losses included.
3. A stranger installs it and files an issue proving they saw their own number.
4. Stars follow 1–3. They are the lagging indicator, never the target.

The Census is already public and already the top of this funnel: people who read
"we measured whether AI reviewers work" are exactly the people who will want the
same measurement on their own repo. **The study is the marketing; the product is
the study made personal.**
