# DiffHawk — Outcome-Signal Evaluation

Phase 1 is called *"trust the number."* The number is the effectiveness rate, and
it rests entirely on one signal: **did a comment lead to a code change?** DiffHawk
answers that with GitHub's `isOutdated` flag on the review thread. This document
is the honest accounting of how far that signal can be trusted — including the
part where the investigation did not go the way it was supposed to.

## The method

To validate `isOutdated` we need a signal *independent* of it. The harness
(`packages/eval`) builds one from raw git history: for each review comment on a
closed or merged PR, it fetches the commits pushed **after** the comment and
checks whether any of them changed the commented file near the commented line. If
so, the comment was plausibly acted on. That "commit-overlap" label is computed
without ever looking at `isOutdated`, so agreement between the two would be
meaningful evidence.

Everything is frozen to a corpus (`packages/eval/corpus/seed.jsonl`) and can be
re-scored offline and deterministically:

```bash
bun run eval NethermindEth/juno hoprnet/hoprnet --prs 30   # build a fresh corpus
bun run eval --corpus packages/eval/corpus/seed.jsonl       # re-score, no network
```

## The result — and it is not a clean pass

On a corpus of 85 AI review threads across 4 repositories:

| Metric | Value |
|---|---|
| Agreement, all threads | **63.5%** |
| Agreement, reliable subset (1 post-comment commit) | 33.3% (n=24) |
| Precision / recall (vs commit-overlap gold) | 76.5% / 53.1% |
| Inflation (`isOutdated`=acted, gold disagrees) | 9.4% |
| Deflation (gold=acted, `isOutdated`=not) | 27.1% |

A naive reading says `isOutdated` is only ~64% accurate. **That reading is wrong,
and finding out why is the actual result of Phase 1.**

## The commit-overlap "gold" is the unreliable one

Hand-verifying the disagreements showed the independent signal — not
`isOutdated` — is what breaks:

- **`hoprnet/hoprnet#8238`, `protocols/pix/src/traits.rs:193`** — `isOutdated` is
  `false`. A commit changed the region `179–195`, so the overlap check flagged
  "acted." But the commented line 193 itself was **untouched** in the merged code;
  the nearby edit was unrelated. `isOutdated=false` is correct; the gold's "acted"
  is a false positive from the line window catching a neighbour.

- **`hoprnet/hoprnet#8238`, `non_anonymous_pix.rs:138`** — `isOutdated` is `true`
  (the anchored code did change), but the gold says "not acted." The cause is a
  coordinate-system mismatch: for an outdated thread GitHub returns `line: null`,
  so the harness falls back to `originalLine`, which is a **position in the
  original diff**, not a line in any commit's file. Comparing it to commit patch
  coordinates cannot line up.

Three different coordinate systems are in play — the comment's HEAD line, its
`originalLine` diff position, and each commit's own patch line numbers — and they
only coincide in narrow cases. Across multiple commits, line numbers drift. So the
commit-overlap gold is **noisier than the signal it was built to check.** Its low
"agreement" measures its own error as much as `isOutdated`'s.

## Conclusion

1. **`isOutdated` is retained as the outcome signal.** It is GitHub's own anchor
   tracking, it is precise about the specific commented line, and every attempt
   here to build a cheaper independent gold was less reliable than it.
2. **A cheap automated ground truth cannot certify it.** Certification needs
   human labels — a person reading each thread and its resolution. The harness is
   built to score exactly that: the corpus format already carries a `gold` field,
   and offline re-scoring will report agreement against hand-edited labels the
   moment they exist.
3. **The exit gate — ≥90% agreement with a human — is therefore not yet met, and
   is not claimed.** Faking it would betray the one thing this project is about.
   A hand-labelled gold set is the honest next step and is scoped as such.

## What ships anyway: honest caveats on every scorecard

The biases the investigation confirmed are attached to every scorecard at
runtime (`packages/core/src/pipeline/score.ts`), not buried here:

- `isOutdated` marks a thread outdated when the anchored lines change — which a
  rebase or an unrelated same-region edit also does (**inflation**), and which a
  fix made elsewhere in the file does not (**deflation**).
- Comments on still-open PRs are **excluded** from the rate as undecided, so a
  fresh window is never scored as failure.
- Comments on PRs closed without merging are flagged: the reviewer may have
  influenced a change that never shipped.

Knowing precisely where a number is soft — and saying so on the number itself —
is what "trust the number" actually means.
