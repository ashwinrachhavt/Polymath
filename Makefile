# `make check` is the gate agents/engineering.md names. It calls the same
# script CI runs, so "passing" has exactly one definition.

.PHONY: install dev check e2e

install:
	pnpm install

dev:
	pnpm dev

check:
	pnpm check

# Needs the dev server, or E2E_BASE_URL pointing at one.
e2e:
	pnpm e2e
