# Multi-stage: resolve dependencies once, then ship a lean non-root runtime.
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Manifests first so the install layer caches across source-only edits.
#
# Every workspace listed in the root package.json must appear here, or bun sees a
# different workspace set than bun.lock describes and --frozen-lockfile fails.
# That failure is loud at build time, which is why the explicit list is safe.
COPY package.json bun.lock ./
COPY packages/core/package.json    packages/core/
COPY packages/ingest/package.json  packages/ingest/
COPY packages/github/package.json  packages/github/
COPY packages/config/package.json  packages/config/
COPY packages/db/package.json      packages/db/
COPY packages/eval/package.json    packages/eval/
COPY apps/api/package.json         apps/api/
COPY apps/worker/package.json      apps/worker/
COPY apps/cli/package.json         apps/cli/
COPY apps/action/package.json      apps/action/
COPY apps/web/package.json         apps/web/
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the ENTIRE resolved tree, not just the root node_modules. Bun gives each
# workspace its own node_modules holding that package's direct dependencies, so
# copying only /app/node_modules leaves every app unable to resolve its imports.
COPY --from=deps /app /app
# Source goes on top. node_modules is in .dockerignore, so this cannot clobber
# the symlink trees copied above.
COPY . .
# The bun image ships a non-root `bun` user. This process parses
# attacker-controlled webhook payloads, so running it as root is avoidable risk.
USER bun
