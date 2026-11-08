# Dev-oriented image for the Polymath web app and outbox worker.
# Source is bind-mounted at runtime; node_modules lives in a named volume so
# native deps match the container platform and `make up` stays one command.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

WORKDIR /app

# Copy only manifests first for a warm dependency layer when building an image;
# bind-mounted dev runs install via docker/entrypoint.sh against the live tree.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY . .

EXPOSE 3000

CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]