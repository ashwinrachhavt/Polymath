# Headroom (MCP, agent tooling)

`.mcp.json` wires a `headroom` stdio MCP server: `uvx --from "headroom-ai[mcp]" headroom mcp serve`.
Coding sessions in this repo get three tools — `headroom_compress`, `headroom_retrieve`,
`headroom_stats` — that shrink large tool output before it lands in the conversation context.
Headroom compresses fresh tool output and new turns only; it does not drop conversation
history. This covers agent tooling only: the app's own LLM calls are not wrapped, and no
proxy is needed for the MCP tools (compression runs locally in the MCP process).

## Prerequisite

The server comes from the Python package (`headroom-ai` on PyPI, Python 3.10+). Install
the CLI once per machine:

```bash
uv tool install "headroom-ai[mcp]"
```

`uvx` fetches the package on demand when it is missing, but a cold fetch delays the first
session start. The `.mcp.json` entry calls `uvx` rather than a bare `headroom` command so
the server still starts when the CLI is not on the MCP host's PATH.

## Tools

| Tool | What it does |
|---|---|
| `headroom_compress` | Compresses content on demand — files, JSON, logs, search results. Returns the compressed text plus a `hash`, original and compressed token counts, and the savings percent. |
| `headroom_retrieve` | Returns the original uncompressed content for a `hash` from a previous compression. Pass `query` to get back only matching items. Local originals expire after 1 hour. |
| `headroom_stats` | Session compression statistics: compressions, retrievals, tokens saved, savings percent, estimated cost saved, and the last 10 events. |

Source: docs.headroomlabs.ai/docs/mcp (retrieved 2026-11-02).

## Checking savings

Call `headroom_stats` in a session and read `tokens_saved` and `savings_percent` first;
`estimated_cost_saved_usd` converts them at current prices. Before reading a large
`headroom` share in Claude Code's `/usage` as overhead, compare `tokens_saved` against
the number of MCP calls — long workflows keep the MCP tool results themselves in context.
