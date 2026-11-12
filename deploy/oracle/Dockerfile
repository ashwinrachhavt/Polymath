# syntax=docker/dockerfile:1
#
# Production image for the Oracle VM (arm64): web, worker and migrate all run
# from it. Built on the server by deploy.sh from a `git archive` of one commit,
# so the context holds tracked files only — no .env, no node_modules.
#
# Dev dependencies stay installed on purpose: the worker runs through tsx and
# migrations through drizzle-kit, both devDependencies.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .

# The public URL the browser uses (the SSH tunnel). NEXT_PUBLIC_* values are
# inlined into the client bundle, so they have to exist at build time.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3300
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# eve/next serves each agent from its built .output under `next start`, so the
# agents are built before Next. Only NEXT_PUBLIC_* keys are read from the
# server's env file (a build secret, never a layer): server secrets and the
# in-network DATABASE_URL have no business in a build step.
RUN --mount=type=secret,id=app_env,required=true \
    set -eu; \
    (cd eve/polymath && /app/node_modules/.bin/eve build); \
    (cd eve/specialist && /app/node_modules/.bin/eve build); \
    grep -E '^NEXT_PUBLIC_[A-Z0-9_]+=' /run/secrets/app_env | grep -v '^NEXT_PUBLIC_APP_URL=' > /tmp/public.env || true; \
    set -a; . /tmp/public.env; set +a; rm -f /tmp/public.env; \
    pnpm build

EXPOSE 3000
CMD ["pnpm", "start", "--hostname", "0.0.0.0", "--port", "3000"]
