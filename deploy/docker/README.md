# Running the stack locally

```bash
cd deploy/docker
export GITHUB_TOKEN="$(gh auth token)"          # read-only; reads public PRs
export GITHUB_WEBHOOK_SECRET="pick-a-secret"    # must match the GitHub App's
docker compose up -d --build
```

Four services: `postgres`, `redis`, `api` (port 3200), `worker`.

```bash
curl localhost:3200/healthz        # liveness: the process is up
curl localhost:3200/readyz         # readiness: postgres + redis reachable
curl localhost:3200/metrics/queues # queue depths and dead-letter size

# Walk a repository's review history, then poll progress
curl -X POST "localhost:3200/repos/kubeedge/kubeedge/backfill?maxPages=3"
curl "localhost:3200/repos/kubeedge/kubeedge/backfill"
curl "localhost:3200/repos/kubeedge/kubeedge/scorecard"
```

## Why api and worker are separate services

Not tidiness. The API is **latency-bound**: a GitHub webhook must be answered
inside a 10 second timeout, so its handler only verifies, dedupes, persists and
enqueues. The worker is **rate-limit bound** and a single job can take minutes.
Scaling them as one unit would mean over-provisioning whichever is idle to serve
the other.

## Scaling workers is safe

```bash
docker compose up -d --scale worker=3
```

The GitHub budget lives in a **Redis token bucket shared by every replica**, so
replicas raise throughput only up to that budget. A limiter held in process
memory would let N replicas each believe they owned the whole budget, making the
real request rate N times the intended one and earning a ban rather than speed.

## Verified behaviour

Run against this Compose stack, not asserted from reading the code:

| Property | How it was checked | Result |
|---|---|---|
| Stack boots | `docker compose up` | api healthy, worker ready |
| Dependencies wired | `/readyz` | postgres ok, redis ok |
| Backfill pipeline | 3-page walk of `kubeedge/kubeedge` | 150 PRs, 221 comments, 2 scorecards |
| Matches bare metal | same repo, host-run services | identical (Gemini 76.5%, Copilot 52.4%) |
| **Idempotent under concurrency** | 3 replicas, 3 simultaneous backfills of one repo | **221 before, 221 after** |
| Work actually distributes | per-replica log counts | 6 / 1 / 1 across three workers |
| Webhook signature | valid, replayed, bad signature, tampered body | 202, duplicate, 400, 400 |
| Graceful shutdown | `docker compose stop --timeout 30 worker` | all replicas **exit 0**, drained |

## Two things this Dockerfile gets right, learned the hard way

1. **Every workspace manifest is copied before `bun install`.** Miss one and
   `--frozen-lockfile` fails, because bun sees a different workspace set than
   `bun.lock` describes. The failure is loud at build time, which is why the
   explicit list is acceptable.
2. **The whole resolved `/app` tree is copied, not just the root
   `node_modules`.** Bun gives each workspace its own `node_modules` holding that
   package's direct dependencies. Copying only the root builds successfully and
   then fails at runtime with `Cannot find package 'bullmq'`.

## Redis is transport, Postgres is truth

Redis runs with persistence disabled on purpose. Losing it costs in-flight jobs,
which are re-enqueued from non-terminal Postgres rows. The measurement record
never lives there, so a Redis flush is an inconvenience rather than data loss.
