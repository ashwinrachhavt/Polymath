# Axiom

Personal OS consolidating command-center, alfred, and neuralflow. This repo is
the consolidation itself — a Next.js 16 modular monolith on Vercel with Neon
Postgres + pgvector as the system of record, not a proxy layer over the donor
backends. The donor repos (`~/Projects/{command-center,alfred,neuralflow}`) are
frozen read-only references; never edit them.

## The brain — read on demand

The product, architecture, and stance documents are binding, but they are **not**
pre-loaded. Read the ones a task actually needs instead of expecting them in
context. Where two disagree, the newer `docs/` document wins; where code and docs
disagree, say so instead of silently following one.

Pinned (small, always in context):

@agents/README.md
@agents/product.md
@agents/engineering.md

Read on demand — pull in only when the task touches that area:

- `docs/axiom-product-spec.md` — product behaviour, scope, user-facing contracts.
- `docs/axiom-nextjs-neon-plan.md` — architecture, data model, Next.js/Neon plan.
- `agents/design.md` — design language, components, visual stance.

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

You MUST use the Serena MCP tools for code navigation (symbol search, file
outlines, finding references, symbol-level edits). They are token-efficient and
exact. Fall back to Read/Glob/Grep only for non-code files (config, docs,
frontmatter) or when Serena genuinely doesn't cover the case.

## Token discipline — always on

Context is the scarce resource. Every avoidable token is a token not spent on the
task.

- **Never read a whole file to find one thing.** Use Serena `find_symbol`,
  `get_symbols_overview`, `find_referencing_symbols`, or a targeted Grep first.
- **Do not re-read files you (or a previous tool) already read** in this session.
  Reuse what is in context.
- **Keep tool output small.** Prefer `head`/`--stat`/`git diff --stat`/counts over
  full dumps. Pipe large command output through filters.
- **Scope Bash.** Avoid `ls -R`, `cat` of large files, and recursive greps across
  `node_modules`/`.next`; target paths explicitly.
- **Batch edits.** Make one edit that changes several lines rather than many
  single-line edits to the same file.
- **Don't paste large blobs back.** Summarise; reference file paths.
- **Sub-agents for breadth.** Delegate wide searches/reads to a sub-agent so their
  intermediate output doesn't land in the main window.
- **Loaded docs are opt-in.** See "The brain — read on demand" above; don't pull
  in a long spec unless the task needs it.
- **Bash output is auto-compressed.** A `rtk` PreToolUse hook rewrites shell
  commands (e.g. `git status` → `rtk git status`) to filter output before it
  reaches you. Use shell commands for their compact form; don't fight the hook.

## Output style — terse

Write like a senior engineer, not a blog post. Token discipline applies to *your*
output too.

- No preamble, no "Great question", no restating the request, no summary of what
  you're about to do. Start with the answer or the action.
- Full sentences only where they carry meaning; prefer short imperative bullets.
- Code, commands, paths, and error text stay exact — never abbreviate those.
- No closing pleasantries or offers to help further.
- One-line status updates while working; expand only when asked.
