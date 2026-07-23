# DiffHawk — Positioning

## The one-line claim

> **DiffHawk tells you whether the AI code reviewer you already run is actually
> earning its place — and quietly turns off the parts that aren't.**

## This claim is not a guess. It was measured first.

Before writing a line of the product, I built [AI Code Review
Census](https://github.com/AnishBplayz/ai-reviewer-census) — a study of AI code
reviewer behaviour across **813 public repositories and 22,000+ pull requests**.
Three numbers from it define this entire project:

| Finding | Value | What it means for the product |
|---|---|---|
| Repos running **any** AI reviewer | **~38%** | The market is real and large. |
| Repos running **2 or more** | **~12%** | Nobody is drowning in competing bots. |
| Cross-vendor **duplicate rate** | **~10%** | The bots that coexist rarely collide. |
| AI comments that **led to a code change** | **44%** | Over half of AI review comments change nothing… |
| The same rate for **human** comments | **60%** | …but so do a third of human ones. The average alone isn't a crisis. |

The average is not the product. **The distribution is.** Broken out per
repository (813 repos, 22,000+ PRs, 11,000+ AI review threads), the picture the
44% average hides is the actual finding:

| Per-repo AI action rate | |
|---|---|
| p10 | **13%** |
| median | 44% |
| p90 | 69% |
| Repos where the reviewer is acted on **≤25%** of the time | **~19%** — nearly 1 in 5 |
| Repos **≤15%** — reviewer is effectively noise | **~13%** |

The worst repos sit at **0–3% acted-on with dozens of comments per window** — a
reviewer that does nothing, running on a real team, and nobody knows because the
public number they've heard is "44%." **"Your reviewer is fine like everyone's"
is false for one repo in five, and the only way to know which is to measure
*your* repo.** That is the product.

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

- Nobody knows its true hit rate on *their* codebase — and the census proves that
  rate ranges from 0% to 90% depending on the repo. The global average tells you
  nothing about yours.
- Nobody can put a number on "is the $30/dev/month — or the review latency —
  worth it?"
- Nobody notices when it quietly degrades — a reviewer that dropped from 50% to
  20% after a model change looks identical from the outside.
- The vendor's own dashboard will never tell them, because the vendor is not a
  neutral party about its own value.

The census proves this at population scale. DiffHawk brings the same measurement
down to a single team's repository.

## What DiffHawk does — measure, report, and flag

### 1. Measure

Ingest every comment your existing reviewer leaves (CodeRabbit, Copilot, Cursor,
Codex, Gemini, Greptile — whichever one you run) and track what actually happened
to each: did the anchored code change, was the thread resolved, dismissed, or
ignored. Break it down by file path and severity.

The core signal needs no LLM. "Did the code at these lines change after the
comment?" is answered by git, deterministically — the exact method the census
validated across 22,000+ PRs.

### 2. Report — the Scorecard

A per-repo effectiveness picture, updated on every PR, that answers the one
question the vendor won't: **is this reviewer working here?**

```
CodeRabbit on your-org/api  ·  last 90 days

  312 comments   ·   18% led to a code change   ·   $0.31 / acted-on comment

  Global average for CodeRabbit: 37%.  On your repo it is half that.
  You are in the bottom ~15% of repos running this reviewer.

  by severity          acted on
    high / critical       41%      ← the useful part
    medium                14%
    low / nitpick          4%      ← 60% of the volume, almost none of the value

  by area              acted on
    src/services/**        29%
    src/api/**             22%
    src/ui/**               6%      ← rarely useful here
```

Nobody publishes this number for the tool you run — and the census proves the
number is *not* the 44% everyone quotes. It might be 6%. You cannot know without
measuring your own repo. That is the wedge.

> **A note the data forced.** An earlier draft claimed the noise clusters on
> generated files, migrations, and lockfiles, and that DiffHawk would suppress it
> there. The census killed that too: those paths are **0.8%** of all AI comments —
> modern reviewers already skip them. The ignored comments are spread across real
> source code, separated (if at all) by *severity and comment type*, not path. The
> scorecard reflects what the data actually shows, not what was convenient to
> claim.

### 3. Flag — trend and degradation

DiffHawk watches the number over time and raises a flag when it moves:

- **A reviewer that degraded** — dropped from 45% to 20% after a model change —
  is invisible from the outside and obvious in the trend line.
- **A reviewer that isn't earning its place on your repo at all** — bottom-decile,
  flat, low — is a documented case for tuning its config or dropping it, with a
  number behind the decision instead of a vibe.

This is deliberately *lighter* than auto-suppression, because the data does not
support auto-suppression: a comment that wasn't acted on is not proven wrong (a
correct nitpick a team declines to fix looks identical), so silently muting by
that signal would hide real findings. DiffHawk surfaces and recommends; the human
decides. Whether a finer-grained automatic policy is ever safe — e.g. muting a
reviewer's `low`-severity comments on an area where they're near-zero value — is
an open question the scorecard is designed to answer with evidence first. **The
same discipline that killed two earlier ideas governs this one.**

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
| Tracks per-repo effectiveness trend + degradation | ✅ | ❌ | ❌ | ❌ |
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
| Teams whose reviewer silently went bad | The bottom ~19% at ≤25% acted-on — they can't see it without this. |
| Self-hosting / regulated orgs | Neutral, on-prem, code never leaves their infra. |

## What DiffHawk is *not*

- **Not another reviewer competing on volume.** It measures reviewers; being one
  is optional and secondary.
- **Not a consolidator.** The census killed that; only 12% of teams run 2+.
- **Not a vendor benchmark.** The Census is the global benchmark. DiffHawk is the
  per-repo instrument. Different jobs, shared engine.
- **Not an approver or merger.** It reads and measures; at most it posts a
  scorecard and opens a recommendation. It never merges or writes code.
- **Not an auto-muter.** The data doesn't support suppressing comments just
  because they weren't acted on. DiffHawk surfaces and recommends; humans decide.

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
