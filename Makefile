# `make check` is the gate agents/engineering.md names. It calls the same
# script CI runs, so "passing" has exactly one definition.

.PHONY: install dev check e2e search-up search-down search-logs

install:
	pnpm install

dev:
	pnpm dev

check:
	pnpm check

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
