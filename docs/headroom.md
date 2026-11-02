# Headroom: context compression for Polymath's LLM calls

Headroom compresses chat payloads — fresh tool output and new turns, never
conversation history — before they reach the model provider. This page covers
the product-runtime wiring (`src/integrations/headroom/client.ts`): what is
wired, how to run it locally, and why production is deliberately a no-op until
a hosted proxy exists.

The agent-tooling scope (a `headroom mcp serve` entry in `.mcp.json` for repo
agents) is tracked separately in the token-reduction spec.

## What is wired

Exactly two seams, the same seam the codebase already uses for the
`geminiFetch()` streaming repair — a wrapper around the `fetch` a model call
is handed:

1. **Background generation** — `src/integrations/generation/provider.ts`
   funnels every catalog provider (Mercury, OpenRouter, OpenAI,
   Anthropic-compatible, Cloudflare, Gemini) through the `fetchImpl`
   parameter of `generationProvider`. One wrap covers them all.
2. **The eve agents** — the `createOpenAI({ fetch })` option in
   `eve/polymath/agent/agent.ts` and `eve/specialist/agent/agent.ts`. For
   Gemini models the shim repairs first and Headroom compresses last, so the
   compressor always sees the final payload.

Everything else is deliberately untouched: embeddings (no conversation context
to compress) and the two direct one-off fetches (`search/ai-gateway.ts`,
`extraction/openrouter-vision.ts`).

## The gate and the fail-open contract

Nothing compresses unless `HEADROOM_BASE_URL` is set. Unset — the state of
every deployment today — the wrapper hands back the caller's own `fetch`
unchanged: byte-identical behavior by construction, not by discipline.

When the env is set, each chat request is POSTed to the proxy's
compression-only endpoint (`POST /v1/compress`: messages in, same-shaped
messages out, no provider keys involved) and the compressed messages replace
the originals on the way out. Any failure — proxy down, non-2xx, malformed
response, or a round-trip exceeding `HEADROOM_TIMEOUT_MS` (default 1500) —
logs `[headroom] compress failed, failing open` and sends the original
request. Compression is an optimization, never a dependency: a broken sidecar
must never break a model call. Payloads are never logged.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HEADROOM_BASE_URL` | unset | Proxy base (`http://127.0.0.1:8787` with the compose sidecar). Unset = everything passes through. |
| `HEADROOM_TIMEOUT_MS` | `1500` | Budget for the compress round-trip before failing open. |
| `HEADROOM_API_KEY` | unset | Sent as `X-Headroom-Proxy-Token`/`Bearer` only when the proxy runs with `HEADROOM_PROXY_TOKEN` (the hosted story). The local sidecar is loopback-unauthenticated. |

## Local development

```bash
docker compose up -d headroom   # first pull is a few GB of models
# in .env:
HEADROOM_BASE_URL="http://127.0.0.1:8787"
```

Then use the app (or the eve evals) and check what compression did:

```bash
curl -s http://127.0.0.1:8787/stats | jq '.tokens'
```

**Measurement.** Langfuse is already instrumented for this — the generation
adapter normalizes `prompt_tokens`/`completion_tokens` per call and the
compose.langfuse.yaml stack renders them per generation. Run the same prompt
with `HEADROOM_BASE_URL` unset and set, and compare input tokens; that delta
is Headroom's (eve's own agent-side compaction is a separate effect — see the
spec's load-bearing assumptions for why the two must not be conflated).

**Quality.** Before trusting the savings, spot-check compressed outputs on
real dev traffic: read a few answers produced under compression next to
uncompressed ones. If compression degraded an answer, `HEADROOM_TIMEOUT_MS=1`
is the instant off-switch without deleting the wiring (it fails open on every
call).

## Production story

Compression activates in production only once a hosted Headroom proxy exists.
That is a human provisioning decision, deliberately deferred: Vercel
serverless cannot host the proxy (it is a Python service — no containers on
Vercel, the same reason the deployed app cannot reach the local docling
sidecar). Until a Docker host reachable from Vercel functions is provisioned,
prod runs the fail-open passthrough, which with the env unset is the same
code path as today.

Provisioning that host later means, on the proxy side: `HEADROOM_COMPRESS_ALLOW_REMOTE=1`
(callers are non-loopback), a `HEADROOM_PROXY_TOKEN` plus `HEADROOM_API_KEY`
here, and the `redis` extra for cross-replica session state
(`HEADROOM_COMPRESS_SESSION_STORE`) under concurrent lambdas.
