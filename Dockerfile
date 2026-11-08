# Dev-oriented image for the Polymath web app and outbox worker.
# Source is bind-mounted at runtime; node_modules lives in a named volume so
# native deps match the container platform and `make up` stays one command.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

WORKDIR /app

# Source is bind-mounted at runtime and node_modules lives in a named volume
# (native deps match this container). Dependencies are installed by
# docker/entrypoint.sh on first boot / when the lockfile changes, so there is
# no install layer to bake into this dev image — that would only duplicate work
# and add a ~1 GB node_modules layer that the volume immediately shadows.
COPY . .

EXPOSE 3000

CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]