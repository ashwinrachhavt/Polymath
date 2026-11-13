# How we deployed Polymath to free Oracle Cloud

Polymath had only ever run on one laptop: a Next.js app, a Postgres database, an outbox worker, two eve agents, and a handful of helper services in Docker Compose. We wanted it reachable from anywhere, without a monthly bill. This is how we got there in one day on Oracle Cloud's Always Free tier, what we got wrong on the way, and what we would check first next time.

## The machine

Oracle's Always Free allowance includes Ampere A1 compute: up to 4 arm64 cores and 24 GB of memory, which you can spend as one VM. That is more memory than most paid starter tiers elsewhere, and it matters here. The stack is about ten containers, and two of them are hungry: Docling (document extraction) and Firecrawl (crawling, with its own Postgres, RabbitMQ, and a Playwright browser service).

We already had such a VM running a small Docling service for another project, behind Caddy. Polymath moved in beside it rather than onto a new box, so both projects share one free machine and one TLS terminator.

Everything stayed inside the free allowance: the existing VM, 50 GB of the 200 GB of free block storage, and no new paid resources. The account itself is Pay As You Go, though, which means nothing stops someone from creating a paid resource on it. So we added a budget of one dollar a month that emails the owner at the first cent of actual spend and again if the forecast passes a dollar. It is a smoke alarm, not a cap, and it costs nothing.

## Building for arm64 on the box

Every third-party image we needed (pgvector, SearXNG, Redis, RabbitMQ, all three Firecrawl images, and Docling's CPU build) publishes an arm64 variant. We checked each manifest before writing a line of Compose, which turned what could have been a cross-compilation project into a non-issue.

The app image is built on the VM itself. The laptop never builds or pushes it. A deploy is a `git archive` of one commit, streamed over SSH and unpacked into a release directory, so the server holds no repository credentials at all. The image keeps dev dependencies on purpose: the worker runs through `tsx` and migrations through `drizzle-kit`, and a 4 GB image is a fair price for one image that runs web, worker, and migrations.

Secrets never touch a layer. The build reads the few values it truly needs (the public Clerk key, which is inlined into the browser bundle, plus the Clerk secret, see below) from a BuildKit secret mount, and the env file on the server is mode 600. After each build we grep the image's build output for the secret's actual value, fed in on stdin so it never appears on a command line, and check `docker history` for keys. Both come back empty.

## Private by default, then public on purpose

The first version was private: the web container listened only on the VM's loopback, and the app was reached through an SSH tunnel. Nothing new answered on a public interface, and the cloud security list still allowed SSH from one IP only.

Then the owner wanted to use it from his phone. Two choices made that cheap:

- **sslip.io for the name.** It is a public DNS service that resolves a hostname containing an IP address to that address, so a Let's Encrypt certificate works with no domain, no DNS records, and nothing to renew by hand.
- **The Caddy that was already there.** We added one site block and put the Caddy container on a small Docker network shared with Polymath's web container. Polymath still publishes no public port of its own. Caddy terminates TLS and proxies.

Going public changed the threat model, so the gate moved into the app. Clerk handles sign-in, but a development Clerk instance lets anyone sign up, and every account would be able to spend the deployment's model keys. So the app now has an invite list. A signed-in account that is not on it gets a polite invite-only page in the proxy, and it is refused again in the auth layer before any user or workspace is provisioned. The lookup fails closed: if Clerk cannot be asked, the answer is no.

## The exposure audit

After the final deploy we probed every port the stack uses from outside: the database, Docling, Firecrawl, SearXNG, Redis, RabbitMQ, the eve agents, and the app's own port. All of them timed out. Only SSH (from one IP) and HTTPS answer. Then we probed through HTTPS: the API and the agent session routes answer 401 without a session or a signed token, and the internal outbox route answers 404. The crawler and the metasearch engine sit on an internal network, so the box cannot be used as an open proxy or someone else's scraper.

The VM has its own baseline: key-only SSH with root login off, fail2ban on the SSH unit, unattended security upgrades, and iptables that accept SSH, HTTP, HTTPS, and nothing else. Every container has a memory cap, a CPU cap, and log rotation, so a runaway process or a chatty log cannot take the machine down.

## Backups

Nightly, cron runs `pg_dump` in custom format and confirms that `pg_restore` can read the archive back. A dump that cannot be read is not a backup. The same run archives the uploaded files. Every deploy also takes a dump before it migrates. Seven days are kept on the box, and a single make target copies the newest dump and files archive to the laptop.

A restore that has never been tried is a hope, not a plan, so we tried one. The newest dump was restored into a scratch database and every table's row count compared with live: 164 of 164 tables, 3,542 of 3,542 rows. Then the scratch database was dropped.

## The traps

Each of these cost a deploy cycle. The health checks and smoke tests caught every one before anyone used the app.

1. **`git archive` from a subdirectory archives only that subdirectory.** The deploy script ran it from its own folder and shipped a release that contained nothing but the deploy scripts. Run it from the repository root.
2. **Firecrawl's container starts about eleven Node processes.** At a 2 GB limit the kernel's OOM killer took the API process during boot, in a loop. It needed 4 GB and fewer queue workers.
3. **`eve/next` starts its agents from Next's `rewrites()` hook, and `next start` never calls it.** A production server reads rewrites from the build manifest instead, so the agents' loopback ports stayed closed. The web container now launches both built agents itself, beside `next start`, and exits if any of the three dies so Docker restarts them together.
4. **The app's Clerk proxy answered the agents' own calls with a 404.** Under `next start` the app talks to its agents same-origin from the server, carrying a signed bridge token but no Clerk session, and the proxy treated that as a stranger. On Vercel those routes never reach the proxy. The fix lets `/eve/*` through to eve's own token check, which refuses anything unsigned.
5. **The sign-in page was baked in as a 404.** It renders only when both Clerk keys exist, and the build had only the public one, so the prerendered page said "not found" forever. The build now reads the secret key from the secret mount too.
6. **The database dump predated an account fix.** The laptop had since moved the owner's Clerk identity onto the user row that owns his data. We replayed the same two-row change on the server and compared the result with the laptop by hash.
7. **Uploads had nowhere to go.** Production refused to fall back to local disk, which is right for serverless hosting and wrong for a VM with a volume. The store now accepts an explicit local-disk opt-in, and only with a directory the operator mounted.
8. **Shell portability.** macOS still ships bash 3.2, which misparses a heredoc containing quotes inside `$(...)`. Our syntax check caught it before anything ran.

## What we'd tell ourselves next time

- Check image architectures and the cloud security lists before writing anything.
- Make every deploy step answer one question with a command, not a feeling. Is every container healthy? Do the agents answer? Does a backup restore? Does anything unexpected answer from outside?
- Keep the server's internal secrets its own: the database password and the agents' signing secrets were generated on the box, not copied from a laptop.
- Put a budget alert on any Pay As You Go account on day one, even when the plan is to spend nothing.
