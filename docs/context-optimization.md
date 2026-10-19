# Context & token optimization (Claude Code on `axiom`)

What was leaking, and what now keeps it down. Nothing here is loaded into context
automatically — read it when changing the agent setup.

## What was wrong (measured 2026-10-19)

Across the previous 2h of sessions, ~11.6 MB of context was re-injected:

| source | cost | cause |
|---|---|---|
| `prompt_snapshot` tool schemas | **521 KB/turn, 156 tools** | 71% were MCP tools; Notion alone was 300 KB / 65 tools |
| `instructions` (CLAUDE.md `@`-imports) | **80.8 KB/turn** | `docs/axiom-product-spec.md` (21 KB) + `axiom-nextjs-neon-plan.md` (20 KB) + `agents/design.md` (18 KB) pinned always-on |
| `Bash` tool results | ~550 KB/session | raw terminal output straight into context |
| broken MCP | — | `.mcp.json` launched `mcp-codebase-index`, which was never installed |

## What changed

- **`CLAUDE.md`** — the three heavy docs are now read-on-demand references, not
  `@`-imports. Always-on doc payload dropped ~74% (80.8 KB → ~20.4 KB).
- **`.mcp.json`** — replaced the broken `mcp-codebase-index` with **Serena**
  (`--context claude-code`, single-project). Serena v2 exposes only 2 tools
  (`initial_instructions`, `serena_repl`) instead of ~30, so symbol-level
  navigation costs almost no schema.
- **`.claude/settings.json`** — dropped redundant plugins (`supabase`,
  `chrome-devtools-mcp`, `jev`, `github`); added Serena hooks
  (`activate` / `remind` / `auto-approve` / `cleanup`).
- **Notion MCP** removed from `~/.claude.json` for this project (it was the single
  largest tool-schema cost). Re-enable: `claude mcp add --transport http notion https://mcp.notion.com/mcp`.
- **RTK** (`/opt/homebrew/bin/rtk`) — PreToolUse hook rewrites Bash commands
  (`git status` → `rtk git status`) to compress terminal output 60–90%. Wire-up in
  `~/.claude/settings.json`; guidance in `~/.claude/RTK.md`.
- **Headroom** — compresses context and keeps Claude Code's on-demand tool loading
  on. Chain: `Claude Code → Headroom :8787 → LiteLLM :4000 → Hive`.

## Running Claude Code with everything

```sh
claude-headroom            # normal Claude Code, routed through the whole chain
claude-headroom --resume <id>
```

Plain `claude` still works (uncompressed, straight to LiteLLM :4000).

## Headroom notes

- Upstream is set with **`ANTHROPIC_TARGET_API_URL`** (not `ANTHROPIC_API_URL`),
  plus `HEADROOM_ALLOWED_BASE_URLS=127.0.0.1:4000`.
- Custom model limits live in `~/.headroom/models.json` (both Hive models → 1M).
- Check health / savings: `headroom doctor`, `headroom perf`, `headroom dashboard`.

## MCP servers, measured

Added 2026-10-19. Each row is the `tools/list` payload the server contributes to
every request, measured against the live endpoint:

| Server | Tools | Schema |
|---|---|---|
| context7 (HTTP) | 2 | 5.3 KB |
| code-index (uvx) | 14 | 8.7 KB |
| gmail (HTTP) | 23 | 73 KB |
| linear, figma (HTTP) | — | OAuth-gated; measured after sign-in |

Gmail is now the largest single schema cost — roughly 18k tokens per request.
If a session is not doing mail work, that is the first server to disable
(`claude mcp remove gmail -s project`); `claude mcp add` restores it.

Linear and Figma require an interactive `claude` session to complete OAuth once;
they stay `Pending approval` until then. Context7 needs no key.

## Deliberately skipped

The other "index MCP" tools from the top-10 roundups (code-review-graph, Token
Savior, claude-context, Graphify, Context Mode, token-optimizer\*) still
duplicate Serena and were not added. `code-index-mcp` is the one exception the
operator asked for — it supplements Serena with whole-repo regex search and
file summaries, at 8.7 KB. Treat the pair as one index: prefer Serena symbols,
fall back to code-index for cross-file text search.
