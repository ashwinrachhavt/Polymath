# Polymath on the Oracle VM

The whole app as it runs on the laptop, minus Langfuse and dozzle, on the
Oracle Cloud Always Free VM (4 Ampere cores, 24 GB, Ubuntu 24.04, arm64).
It is on the public internet over HTTPS (see "Public access"), behind Clerk
sign-in, and also reachable privately through an SSH tunnel.

The server's database is its own copy. It started from the laptop backup of
2026-11-12; from then on the laptop and the server diverge.

## What runs

`compose.oracle.yaml`, project `polymath`, in `/opt/polymath`:

| Service                                                                 | Role                                          | Memory cap |
| ----------------------------------------------------------------------- | --------------------------------------------- | ---------- |
| db                                                                      | Postgres 17 + pgvector                        | 3 GB       |
| web                                                                     | `next start`, plus both eve agents (loopback) | 4 GB       |
| worker                                                                  | outbox worker                                 | 2 GB       |
| docling                                                                 | document extraction (CPU build)               | 4 GB       |
| searxng, redis-search                                                   | private metasearch                            | 0.75 GB    |
| firecrawl, firecrawl-playwright, firecrawl-postgres, firecrawl-rabbitmq | crawling                                      | 7.75 GB    |

Only `web` publishes a port, on `127.0.0.1:3000` of the VM; the public site
reaches it through Caddy (below). `migrate` runs once per deploy. The eve agents
are not separate containers: `start-web.sh` runs each built agent on a loopback
port inside `web` (4274, 4275) beside `next start`. `eve/next` would start them
itself from `rewrites()`, but `next start` serves rewrites from the build
manifest and never calls it.

The Transactwise docling stack in `/opt/docling` is a different service. Its
Caddy (ports 80/443) also serves Polymath's public name; nothing else there
changed.

## Setup on the laptop

The VM's address stays out of this public repo. Create
`~/.config/polymath/oracle.env`:

```sh
ORACLE_HOST=ubuntu@<vm public ip>
ORACLE_SSH_KEY=$HOME/.ssh/oci_docling
ORACLE_PUBLIC_URL=https://polymath.<vm ip with dashes>.sslip.io
```

SSH ingress is limited to one source IP in the OCI security list `docling-sl`.
If your home IP changes, update that rule in the OCI console first.

## Open the app

Open `$ORACLE_PUBLIC_URL` and sign in with Clerk.

Privately, through SSH:

```sh
make oracle-tunnel
```

Then open http://localhost:3300. The tunnel is the same as
`ssh -i ~/.ssh/oci_docling -N -L 3300:127.0.0.1:3000 $ORACLE_HOST`. Port 3300
is used because the laptop's own Docker stack holds 3000.

## Public access

`polymath.<ip with dashes>.sslip.io` resolves to the VM through sslip.io, so no
DNS setup is needed. The Caddy in `/opt/docling` holds a Let's Encrypt
certificate for it and proxies to `polymath-web:3000` on the `polymath-edge`
Docker network, which both compose projects share. The Polymath part of that
setup on the VM:

- `/opt/docling/Caddyfile` ends with a `polymath.<...>.sslip.io` site block
  (`reverse_proxy polymath-web:3000`).
- `/opt/docling/compose.yaml` puts the `caddy` service on the external
  `polymath-edge` network.
- The originals are kept as `*.bak-20261112` next to them.

To go back to private-only, remove both, run
`sudo docker compose up -d caddy` in `/opt/docling`, set `ORACLE_PUBLIC_URL`
to `http://localhost:3300`, then run `make oracle-env` and `make oracle-deploy`.

## Invite only (off)

The app supports an invite list: `POLYMATH_ALLOWED_EMAILS` (comma-separated)
admits only listed, verified Clerk addresses, sends anyone else to
`/invite-only`, and never provisions them (`src/lib/access-allowlist.ts`).
It is **off on this server** at the owner's request, so any Clerk account can
sign in. Protection against strangers spending the model keys comes from the
per-account free-allowance limits instead. To turn the list on, add the line
to `/opt/polymath/.env` on the VM and run `make oracle-deploy`. `push-env.sh`
keeps it once it is there and never copies it from the laptop.

Sign-ups can also be closed in Clerk: in the dashboard for this app's
Development instance, open Configure, then Restrictions.

## Deploy

```sh
make oracle-deploy                 # origin/main
make oracle-deploy REF=<sha|branch>
```

`deploy.sh` sends the commit to the VM as a `git archive` over SSH (the VM has
no GitHub credentials), then `server/release.sh`:

1. builds `polymath-app:<sha>` on the VM (arm64; the eve agents, then `next build`)
2. backs up the database (`backups/axiom-<stamp>-pre-deploy.dump`)
3. runs migrations; if they fail, the running release is not touched
4. recreates the containers and waits for every healthcheck
5. checks `/landing`, `/polymath` and both eve agents' health routes
6. on failure, starts the previous release again and exits non-zero

`make oracle-status` shows the live release, container health, memory and disk.

## Roll back

```sh
make oracle-rollback
```

This starts the previous release's image again. Migrations are forward-only and
stay applied, so roll back only to a release that works with the current schema.
To undo data changes as well, restore a backup (below).

## Secrets

`/opt/polymath/.env` (mode 600, owner `ubuntu`) is the laptop's `.env` +
`.env.local`, rewritten for production by `push-env.sh`. It sets `NODE_ENV=production`,
uses in-network service URLs and `$ORACLE_PUBLIC_URL` as the app origin, and drops
Langfuse, the test database and `POLYMATH_DEV_AUTH`. The Postgres password and
both eve token secrets are the server's own: generated there on the first push,
kept on later ones, never copied from the laptop. `env.example` lists every key
by name. To push changed keys, run this, then deploy:

```sh
make oracle-env
```

To check the env without printing it (set or missing per key, plus free live
checks of Postgres, Clerk, the in-network services and each model provider's
`/models`), run this on the VM:

```sh
cd /opt/polymath && R=$(cat current-release)
sudo env POLYMATH_RELEASE=$R docker compose -p polymath --env-file .env -f releases/$R/deploy/oracle/compose.oracle.yaml exec -T web pnpm exec tsx deploy/oracle/check-env.ts
```

The build reads `NEXT_PUBLIC_*` and `CLERK_SECRET_KEY` from a BuildKit secret
mount, never a layer. The Clerk key is needed only so `/sign-in` prerenders,
and Next inlines only `NEXT_PUBLIC_*`. Verified on 2026-11-12: no file in the
image's build output contains the Clerk secret, and `docker history` holds no
key.

## Uploads

Uploaded originals live on the `blobs` volume at `/data/blobs`, mounted on web
and worker (extraction runs in the worker). `push-env.sh` sets
`POLYMATH_OBJECT_STORE=local-disk` and `AXIOM_LOCAL_BLOB_DIR=/data/blobs`. The
files are read only through authenticated routes, never served statically. If
the env ever carries a Vercel Blob token, Blob wins for new uploads, and older
local files stay readable.

## Error monitoring (Sentry)

The app reports errors to Sentry when a DSN is set; without one, it is off.
Put the keys in the laptop's `.env` (`push-env.sh` carries them), then run
`make oracle-env` and `make oracle-deploy`:

- `NEXT_PUBLIC_SENTRY_DSN` (inlined into the browser bundle at build time) and
  `SENTRY_DSN`
- optional: `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`
- optional, for readable stack traces: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
  `SENTRY_PROJECT`. The build uploads source maps only when all three are set,
  and reads them from the build secret, never a layer.

## Connectors (Composio)

Nothing to change in the Composio dashboard. Each connect sends Composio a
return URL built from `APP_ORIGIN` (`/api/integrations/callback`), and the auth
configs are Composio-managed OAuth, so providers redirect to Composio's own
callback first. The server carries `COMPOSIO_API_KEY` and the
`COMPOSIO_AUTH_CONFIG_*` ids from the laptop. Connections made on the laptop
are Composio accounts, so they work from the server too. Only if you switch a
toolkit to your own OAuth app do you register a redirect URI, and that one is
Composio's (shown in its dashboard), not this server's.

## Back up

- Nightly at 10:30 UTC, `/etc/cron.d/polymath-backup` runs `server/backup.sh`:
  `pg_dump -Fc` into `/opt/polymath/backups/`, checked with `pg_restore -l`,
  kept for 7 days. The log is `/opt/polymath/backups/backup.log`.
- Every deploy takes a `-pre-deploy` dump before it migrates.
- The same run archives the uploaded files: `blobs-<stamp>.tar.gz`, checked by
  listing it back, also kept for 7 days.
- Off-box copy: `make oracle-backup-pull` copies the newest dump and the newest
  files archive to `~/Backups/polymath/oracle/`.

## Restore

Check that a backup restores without touching live data. This restores into a
scratch database, compares row counts with the live database, then drops it:

```sh
ssh -i ~/.ssh/oci_docling $ORACLE_HOST sudo /opt/polymath/current/deploy/oracle/server/restore.sh --verify
```

To replace the live database with a dump, run this on the VM:

```sh
cd /opt/polymath
R=$(cat current-release)
c() { sudo env POLYMATH_RELEASE=$R docker compose -p polymath --env-file .env -f releases/$R/deploy/oracle/compose.oracle.yaml "$@"; }
c stop web worker
sudo current/deploy/oracle/server/backup.sh before-restore
sudo docker exec polymath-db-1 psql -U axiom -d postgres -c 'drop database axiom' -c 'create database axiom'
sudo current/deploy/oracle/server/restore.sh /opt/polymath/backups/<file>.dump axiom
c run --rm migrate
c up -d --wait
```

To restore the uploaded files from an archive (with web and worker stopped):

```sh
B=$(sudo docker volume inspect -f '{{.Mountpoint}}' polymath_blobs)
sudo tar -xzf /opt/polymath/backups/blobs-<stamp>.tar.gz -C "$B"
```

## Firewall and cost

- OCI security list `docling-sl` (the only one attached to the subnet): TCP 22
  from one IP, and TCP 80/443 from anywhere (Caddy: Transactwise and Polymath).
- VM iptables: INPUT accepts 22, 80, 443, ICMP and loopback, then rejects.
  rpcbind listens on 111 but is rejected there and in the security list.
- fail2ban watches `ssh.service`. `/etc/ssh/sshd_config.d/10-polymath-hardening.conf`
  sets keys only, `PermitRootLogin no` and `MaxAuthTries 3`.
- Polymath adds nothing to either list.
- Every container has a memory and CPU cap and json-file log rotation
  (3 x 10 MB).
- Cost: everything here is inside Oracle's Always Free allowance (4 A1 cores,
  24 GB, 50 GB of the 200 GB of free block storage). The tenancy is Pay As You
  Go, so a budget `free-tier-guard` (1 USD a month) emails the account owner
  at the first cent of actual spend and when the forecast passes 1 USD.
