# Dev-oriented image for the Polymath web app and outbox worker.
# Source is bind-mounted at runtime; node_modules lives in a named volume so
# native deps match the container platform and `make up` stays one command.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate
RUN pnpm --version

WORKDIR /app

# Compose bind-mounts the repository at /app and keeps dependencies in a volume.
# The source tree and local caches do not belong in this development image.

EXPOSE 3000

CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]