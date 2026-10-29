# `make check` is the project's gate. It calls the same
# script CI runs, so "passing" has exactly one definition.

.PHONY: install dev check e2e search-up search-down search-logs queue-up queue-down queue-logs seed-taxonomy

install:
	pnpm install

dev:
	pnpm dev

check:
	pnpm check

# Regenerates docs/generated/inventory.md from the tree. The fact half of the
# technical spec; run it whenever a schema, route, tool, or topic changes.
inventory:
	pnpm exec tsx scripts/tech-spec-inventory.ts

# Fails if the generated inventory is stale. `make check` runs this, so a schema
# change without a regenerated inventory cannot pass the gate.
inventory-check:
	pnpm exec tsx scripts/tech-spec-inventory.ts --check

# Needs the dev server, or E2E_BASE_URL pointing at one.
e2e:
	pnpm e2e

# SearXNG + Firecrawl. First run generates the SearXNG settings with a local
# secret; compose pulls the images. Bound to 127.0.0.1 only.
search-up:
	@test -f scripts/local-search/searxng/settings.yml || \
		sed "s/__SEARXNG_SECRET__/$$(openssl rand -hex 32)/" \
			scripts/local-search/searxng/settings.yml.tpl > scripts/local-search/searxng/settings.yml
	docker compose up -d searxng firecrawl
	@echo "searxng  http://127.0.0.1:8080"
	@echo "firecrawl http://127.0.0.1:3002"

search-down:
	docker compose rm -sf searxng firecrawl firecrawl-playwright firecrawl-postgres firecrawl-rabbitmq redis-search

search-logs:
	docker compose logs -f searxng firecrawl

# The outbox drain. Uploads and crawls queue work in the database; nothing moves
# without this process. Runs on the host (it imports src/, so it needs the repo
# and its node_modules, not a container image).
queue-up:
	@mkdir -p .run
	@nohup pnpm exec tsx --env-file=.env scripts/outbox-worker.ts >> .run/outbox-worker.log 2>&1 & echo $$! > .run/outbox-worker.pid
	@echo "outbox worker started (pid $$(cat .run/outbox-worker.pid)) - make queue-logs to follow"

queue-down:
	@test -f .run/outbox-worker.pid && kill $$(cat .run/outbox-worker.pid) 2>/dev/null || true
	@rm -f .run/outbox-worker.pid
	@echo "outbox worker stopped"

queue-logs:
	@tail -f .run/outbox-worker.log

# ASH-272: seed the knowledge taxonomy catalog. Dry run; -- --apply writes.
seed-taxonomy:
	pnpm seed:taxonomy
