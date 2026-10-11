# Axiom

Personal OS consolidating command-center, alfred, and neuralflow. This repo is
the consolidation itself — a Next.js 16 modular monolith on Vercel with Neon
Postgres + pgvector as the system of record, not a proxy layer over the donor
backends. The donor repos (`~/Projects/{command-center,alfred,neuralflow}`) are
frozen read-only references; never edit them.

## The brain — loaded by default

These are the product, architecture, and stance documents. They are always in
context, so treat them as binding rather than as background to search later.
Where two disagree, the newer `docs/` document wins; where code and docs
disagree, say so instead of silently following one.

@docs/axiom-product-spec.md
@docs/axiom-nextjs-neon-plan.md
@agents/README.md
@agents/product.md
@agents/engineering.md
@agents/design.md

`docs/superpowers/specs/2026-10-10-axiom-consolidation-design.md` is an earlier
iframe-over-donor-backends approach that the Next.js/Neon plan supersedes. It is
historical; do not build from it.

Precedence: `agents/*` > this file > skill defaults.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Codebase Navigation — MANDATORY

You MUST use codebase-index MCP tools FIRST when exploring or navigating the codebase. Only fall back to Read/Glob/Grep for non-code files (config, docs, frontmatter) or when codebase-index genuinely doesn't have what you need.
