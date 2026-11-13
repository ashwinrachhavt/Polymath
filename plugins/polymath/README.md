# Polymath plugin for Claude Code and Codex

Ask your coding agent to explain a change. Polymath writes a literate explainer note, you answer a short check in the terminal, and the concepts you missed become review items in your daily practice in Polymath. Nothing runs unless you invoke it.

## Get an API key

In Polymath, open Settings > API keys and create a key with the scopes `understanding:read`, `understanding:write` and `captures:write`. The key starts with `axm_`.

## Claude Code

Install from the marketplace in this repo:

```
/plugin marketplace add ashwinrachhavt/Polymath
/plugin install polymath@polymath
```

The same from a shell:

```
claude plugin marketplace add ashwinrachhavt/Polymath
claude plugin install polymath@polymath
```

Claude Code asks for two values: the Polymath URL (default `http://localhost:3000`) and your API key. The key is stored as a sensitive value.

Then, inside any git repository:

```
/polymath:explain [range]
```

With no range it explains the last commit, or your uncommitted changes when the tree is dirty. A range looks like `main..HEAD`.

From a checkout of this repo, without installing:

```
claude --plugin-dir ./plugins/polymath
```

You can also run the MCP server by hand with `pnpm polymath-mcp`. It reads `POLYMATH_URL` and `POLYMATH_API_KEY` from the environment.

## Codex

Codex has no plugin install, so it uses the MCP server directly.

1. Add the server to `~/.codex/config.toml`. Copy `codex/config.toml.example` and set the absolute path to `plugins/polymath/mcp/server.mjs`. Codex does not expand `${VAR}` in args, so the path must be absolute. Export `POLYMATH_API_KEY` and `POLYMATH_URL` in your shell.
2. Or add it from the CLI: `codex mcp add polymath --env POLYMATH_URL=http://localhost:3000 -- node /absolute/path/to/plugins/polymath/mcp/server.mjs`, then export `POLYMATH_API_KEY` yourself so the key stays out of the config file.
3. Paste `codex/AGENTS.snippet.md` into your `AGENTS.md`. Then ask "explain this change with Polymath" or type `/polymath-explain`.

## Tools

| Tool                  | What it does                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `explain_change`      | Sends the diff and a session summary, returns the note URL and explainer id. |
| `check_understanding` | Fetches the questions, then grades your answers and queues review items.     |
| `what_do_i_know`      | Lists concepts that are known, shaky or not yet tested.                      |
| `capture`             | Saves text or a link to your Polymath inbox.                                 |

## Preferences

Two optional behaviors are off by default and are switched on in Polymath Settings. Auto-suggest nudges Claude Code to suggest `/polymath:explain` after a commit that changes 150 or more lines. The push warning prints a one-line warning before `git push` when the commit has no passed check. It never blocks the push. Question count and difficulty are set there too. Both hooks stay silent when Polymath is unreachable or no key is set. Codex has no hooks, so these apply to Claude Code only.

## Works with your own model key or hosted Polymath

The plugin only needs a URL and an API key. Model costs are whatever the Polymath server you point it at is configured with: your own model key on a self-run server, or the hosted service.
