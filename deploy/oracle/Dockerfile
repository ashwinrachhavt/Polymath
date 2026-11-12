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
# agents are built before Next.
#
# The build reads two kinds of key from the server's env file, mounted as a
# BuildKit secret (never written to a layer): NEXT_PUBLIC_* for the client
# bundle, and CLERK_SECRET_KEY because `clerkConfigured` (src/lib/clerk.ts)
# needs both Clerk keys while /sign-in is prerendered — without it the page is
# baked in as a 404. Next inlines only NEXT_PUBLIC_*, so the secret key stays a
# runtime read; README "Secrets" has the check that the image holds no value.
# Everything else (the in-network DATABASE_URL, provider keys) stays out.
RUN --mount=type=secret,id=app_env,required=true \
    set -eu; \
    (cd eve/polymath && /app/node_modules/.bin/eve build); \
    (cd eve/specialist && /app/node_modules/.bin/eve build); \
    grep -E '^(NEXT_PUBLIC_[A-Z0-9_]+|CLERK_SECRET_KEY)=' /run/secrets/app_env | grep -v '^NEXT_PUBLIC_APP_URL=' > /tmp/build.env || true; \
    set -a; . /tmp/build.env; set +a; rm -f /tmp/build.env; \
    pnpm build

EXPOSE 3000
CMD ["bash", "deploy/oracle/start-web.sh"]
