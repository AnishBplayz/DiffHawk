# Multi-stage: install once, then ship a lean non-root runtime.
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
# Copy only manifests first so the install layer caches across source edits.
COPY package.json bun.lock ./
COPY packages/core/package.json      packages/core/
COPY packages/ingest/package.json    packages/ingest/
COPY packages/github/package.json    packages/github/
COPY packages/config/package.json    packages/config/
COPY packages/db/package.json        packages/db/
COPY packages/eval/package.json      packages/eval/
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/cli/package.json           apps/cli/
COPY apps/action/package.json        apps/action/
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# bun's image ships a non-root `bun` user; running as root in a container that
# processes attacker-controlled webhook payloads is an avoidable risk.
USER bun
