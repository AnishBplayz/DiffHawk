> **⚠️ Historical — this is the original seed idea, kept for provenance.**
>
> DiffHawk started here: "build another AI PR reviewer." Two things changed it.
> First, a market check showed that space is saturated (GitHub Copilot, Cursor,
> Codex, CodeRabbit, Greptile, and a dozen open-source clones). Second — and this
> is the part worth reading the repo for — instead of guessing a differentiator, I
> **measured the market**: the [AI Code Review
> Census](https://github.com/AnishBplayz/ai-reviewer-census), 716 repos and
> 15,000+ PRs. The data killed a consolidator idea before it was built and pointed
> at the real gap: **nobody tells you whether the reviewer you already run is
> working.**
>
> The current direction lives in **[docs/POSITIONING.md](docs/POSITIONING.md)** and
> the [README](README.md). Everything below is preserved as the starting point of
> that evolution — the systems layer it describes (NestJS, BullMQ, retries, K8s)
> survived the pivot intact; only what the system *does* changed.

---

# DiffHawk — AI PR Review Bot *(original seed idea)*

## What it is

A GitHub App that reviews pull requests automatically using an LLM, queued and processed asynchronously so it stays reliable under load and survives API rate limits gracefully. Not a wrapper around a single API call — a real background-processing system with retries, backoff, and status tracking, that happens to use AI as the thing being processed.

## Why this one

- **It's genuinely useful.** You could run it on your own repos (Kothari Cabletronics, NSE pipeline, this very career-ops fork) starting day one, not just as a portfolio artifact that never gets used again.
- **It closes real gaps from real job applications.** NestJS (InsightRx wanted this specifically), a message queue with retry/backoff logic (matches "background job processing via AWS SQS" verbatim), Docker, and Kubernetes manifests (Canonical's nice-to-have) — all in one coherent system instead of three disconnected exercises.
- **It directly backs a claim you already made.** You told Razorpay "AI is my helping hand down to the core of how I build." Right now that's a sentence with no artifact behind it. This project *is* the artifact — the next time an application asks for AI-workflow evidence, you point at a real, working system instead of a paragraph.
- **It's a strong interview story.** "I built a tool that reviews my own PRs" is a better answer to "tell me about a project you're proud of" than most take-home exercises, because it's self-motivated, not assigned.

## Architecture

```
GitHub (PR opened/updated)
        │  webhook
        ▼
  NestJS API  ──validates signature──▶  BullMQ queue (Redis)
        │                                       │
        │                                       ▼
        │                              Worker process
        │                              ├─ fetch diff
        │                              ├─ call LLM (Claude API) for review
        │                              ├─ retry w/ backoff on rate limit/failure
        │                              └─ post review comment via GitHub API
        │
        ▼
  Status API  ──▶  GET /reviews/:id  (poll job status, see what happened and why)
```

## Scope for a first working version (keep it small, ship it)

1. **NestJS API** — one endpoint to receive GitHub's PR webhook, verify the signature, enqueue a job. One endpoint to check job status by ID.
2. **BullMQ worker** — pulls the job, fetches the PR diff via GitHub's API, sends it to an LLM with a focused prompt (not "review everything," pick one lens: e.g. "flag likely bugs and missing error handling only" — a scoped tool beats a vague one), posts the result as a PR comment.
3. **Retry logic that's actually real** — exponential backoff on LLM rate limits, a dead-letter queue after N failures, and the status endpoint should honestly report failures instead of hiding them. This is the part that actually demonstrates "background job processing," not the happy path.
4. **Docker Compose** — API + worker + Redis, one `docker compose up` to run the whole thing locally.
5. **Kubernetes manifests** — Deployment + Service for the API, a separate Deployment for the worker (so they scale independently, which is the actual point of splitting them), a StatefulSet or managed-Redis reference for the queue. Doesn't need a live cluster to be real — correct manifests plus a short README explaining the scaling rationale is the evidence that matters.

## Explicitly out of scope for v1 (don't gold-plate it)

- Multiple LLM providers / model switching
- A web dashboard (the status API is enough; a UI is a v2 problem)
- Reviewing every file type / every language — pick one scoped lens and do it well
- Auto-merge or any write access beyond posting a comment — this should never take actions with real consequences on its own

## Suggested build order

1. NestJS skeleton + webhook endpoint that just logs the payload (prove the wiring works)
2. Add BullMQ + Redis, enqueue a fake job, confirm a worker picks it up
3. Wire the real LLM call into the worker, hardcode one repo/PR to test against
4. Add retry/backoff and the dead-letter path — deliberately break something to prove it survives
5. Docker Compose for local dev
6. Kubernetes manifests + a short doc explaining what would happen if the worker fell over

## Naming

Name checked 2026-07-23 — no existing GitHub project, npm package, or product found under "DiffHawk" across GitHub, npm, or general web search. Clear to use.
