# Polymath on the Oracle VM

The whole app as it runs on the laptop, minus Langfuse and dozzle, on the
Oracle Cloud Always Free VM (4 Ampere cores, 24 GB, Ubuntu 24.04, arm64).
It is private: nothing new listens on a public interface, and you reach it
through an SSH tunnel at `http://localhost:3300`.

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

Only `web` publishes a port, on `127.0.0.1:3000` of the VM. `migrate` runs once
per deploy. The eve agents are not separate containers: under `next start`,
`eve/next` serves each built agent on a loopback port inside `web`.

The Transactwise docling stack in `/opt/docling` (Caddy on ports 80/443) is a
different service and is left alone.

## Setup on the laptop

The VM's address stays out of this public repo. Create
`~/.config/polymath/oracle.env`:

```sh
ORACLE_HOST=ubuntu@<vm public ip>
ORACLE_SSH_KEY=$HOME/.ssh/oci_docling
```

SSH ingress is limited to one source IP in the OCI security list `docling-sl`.
If your home IP changes, update that rule in the OCI console first.

## Open the app

```sh
make oracle-tunnel
```

Then open http://localhost:3300. The tunnel is the same as
`ssh -i ~/.ssh/oci_docling -N -L 3300:127.0.0.1:3000 $ORACLE_HOST`. Port 3300
is used because the laptop's own Docker stack holds 3000.

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
uses in-network service URLs and `http://localhost:3300` as the app origin, keeps
the server's own Postgres password, and drops Langfuse, the test database, and
`POLYMATH_DEV_AUTH`. To push changed keys, run this, then deploy:

```sh
make oracle-env
```

The build reads only the `NEXT_PUBLIC_*` keys, as a BuildKit secret. No value is
stored in an image layer.

## Back up

- Nightly at 10:30 UTC, `/etc/cron.d/polymath-backup` runs `server/backup.sh`:
  `pg_dump -Fc` into `/opt/polymath/backups/`, checked with `pg_restore -l`,
  kept for 7 days. The log is `/opt/polymath/backups/backup.log`.
- Every deploy takes a `-pre-deploy` dump before it migrates.
- Off-box copy: `make oracle-backup-pull` copies the newest dump to
  `~/Backups/polymath/oracle/`.

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

## Firewall

- OCI security list `docling-sl` (the only one attached to the subnet): TCP 22
  from one IP, and TCP 80/443 from anywhere for the Transactwise docling.
- VM iptables: INPUT accepts 22, 80, 443, ICMP and loopback, then rejects.
- fail2ban watches `ssh.service`. SSH accepts keys only, and root login is
  refused.
- Polymath adds nothing to either list.
