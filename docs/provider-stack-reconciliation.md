# Provider stack reconciliation: free-first agents (ASH-187)

**Date:** 2026-10-19
**Source of the direction:** the owner's free-first agent stack brief (iMessage, 2026-10-19) and his approval of the first slice: one Linear ticket (ASH-187), a Tech Spec section, and this PR.
**Rule set:** agents request capabilities through Polymath, never raw provider keys; recurring free allowances with strict budgets and graceful stopping; no paid fallback; unknown costs fail closed.

## What the repo already had (reused, not rebuilt)

| Piece | Where | Status before this PR |
| --- | --- | --- |
| Search adapter seam (`WebSearchProvider`) | `src/integrations/search/provider.ts` | DuckDuckGo default, SearXNG/Brave/Tavily/Exa keyed adapters, env-selected |
| Firecrawl transport (scrape/crawl) | `src/integrations/firecrawl/client.ts` | Self-hosted compose stack only; no hosted search, no credits accounting |
| Local research stack | `compose.yaml` (searxng, firecrawl, redis-search) | Operable since ASH-178 |
| Embeddings seam | `src/integrations/embeddings/provider.ts` | OpenRouter/OpenAI, swappable |
| Agent access-control foundation | ADR 0006 (GA01/02/03/07/10 as-built) | Grants, gateway, decision log; GA09 budgets **proposed, not built** |
| Run budget field | `budgetPolicy` jsonb on run policy snapshots | Recorded, never enforced |
| Generation | OpenRouter hand-rolled in 3 places (zettels, wiki, company-research) + Eve agents | No seam, no free route, no accounting |

## What this PR adds

- **Provider registry** (`src/integrations/providers/registry.ts`): capability, free class, enabled, paid-usage/fallback flags, sensitive-data flag, quota and verification provenance per provider. Unverified entitlements are registered **disabled**.
- **Shared quota ledger** (`src/integrations/providers/quota.ts`, migration `0213_provider_quota_ledger`): per-workspace period buckets with atomic reserve -> execute -> settle/release (the GA09 slice). Hard stop via `QuotaExhaustedError`; failures release their reservation. Append-only usage ledger rows for evidence.
- **Firecrawl hosted search** (`src/integrations/search/firecrawl.ts`): new adapter on the existing seam (`SEARCH_PROVIDER=firecrawl`, `FIRECRAWL_HOSTED_API_KEY`), quota-gated in `web-search.ts` at the verified cost of 2 credits per 10 results.
- **Generation seam** (`src/integrations/generation/`): OpenRouter (status quo) and Gemini (free route) adapters; zettel extraction migrated to the seam with identical default behavior. Wiki summarizer and company-research still hand-roll OpenRouter — migrating them is follow-up, deliberately not bundled here.
- The `web.search` agent tool and `/api/v1/search` route inherit quota gating through `searchWebForAgent`, unchanged signatures.

## Provider verification results (checked 2026-10-19, official sources)

| Provider | Verified entitlement | Source | Registry decision |
| --- | --- | --- | --- |
| Firecrawl (hosted) | 1,000 credits/month, refreshed monthly, **no card**; search 2 credits/10 results, scrape 1 credit/page; search and scrape share one balance | https://www.firecrawl.dev/pricing | **enabled** (search), monthly credits quota |
| Gemini Developer API | Free input/output for `gemini-3.5-flash-lite` and `gemini-3.8-flash`; free-tier data may improve Google products; Google Search grounding NOT available free; RPD resets midnight Pacific | https://ai.google.dev/gemini-api/docs/pricing | **enabled** (generate), daily requests quota, sensitiveDataAllowed=false |
| Composio Hobby | 100k tool calls/mo (managed OAuth is a <=20k subset), 50k triggers (<=10k managed), 10k direct, 1k proxy, 10k sandbox, 1M sandbox LLM tokens/mo, no card | https://composio.dev/pricing.md | enabled (existing), not yet ledger-gated |
| Jina Reader | 20 RPM without key; 500 RPM with free key; free key token grant is **one-time**, not recurring | https://jina.ai/reader/ | registered, disabled (no adapter yet) |
| Parallel | Up to 5,000 free requests/month; card required; excess bills | https://parallel.ai/pricing | registered, card-backed, disabled (needs explicit card consent) |
| Cloudflare Workers AI | 10,000 neurons/day free, resets 00:00 UTC; neurons are not tokens | https://developers.cloudflare.com/workers-ai/platform/pricing/ | registered, disabled (no adapter yet) |
| Brave Search API | $5 per 1,000 requests, prepaid credits, **card required** confirmed; the monthly free allowance could not be re-verified (account-gated dashboard) | https://brave.com/search/api/ | registered, card-backed, **disabled until the account dashboard confirms the allowance** |
| Jev (TypeSafe) | Product and docs verified: `jev-1.14.0`/`jev-1.13.0`, $0.042/M input tokens, free output, 64k/32k context. **No recurring free allowance exists.** | https://docs.typesafe.ai/models | registered, **disabled** (cheap is not free) |
| Cerebras | $5 trial credit, 30-day expiry, no recurring free tier (per the brief's doc read; not re-verified this pass) | https://www.cerebras.ai/ | registered, trial, disabled |
| Tavily, Exa | Current free entitlements not verified | — | registered, unverified, disabled |
| DuckDuckGo / SearXNG / self-hosted Firecrawl | No vendor allowance to spend | — | enabled, no quota (status quo) |
| OpenRouter | Paid, workspace's own key (status quo) | — | enabled, never auto-selected as rescue |

The brief's affiliate-tagged Firecrawl link was not used; all claims were checked against the canonical pages above.

## What the brief asks for that this PR does NOT do (follow-ups, in order)

1. **Migrate the remaining hand-rolled OpenRouter call sites** (wiki summarizer, company-research) onto the generation seam. One seam, no parallel request paths.
2. **Classify seam + rules-first pipeline**: deterministic checks before any model call; a bounded semantic classifier only where genuinely needed. Jev stays disabled until a paid-usage decision exists.
3. **Composio ledger gating** with per-execution-mode unit accounting (the pricing traps are real: managed OAuth is a subset, Instant Tools bill separately).
4. **Jina Reader adapter** for known-URL reading (saves search spend).
5. **Vercel AI Gateway evaluation**: budgets cover system-credential spend only; BYOK meters separately. A gateway budget alone is not a zero-spend control.
6. **Settings UI**: registry-driven provider cards with free-class labels, allowance state from the ledger, and the visible "free allowance exhausted" state.

## Product rules now enforced in code

- No paid fallback by default. No automatic recharge. Unknown provider costs fail closed (unverified entries are disabled).
- Reservations are atomic and shared across concurrent runs; retries consume budget.
- Free-tier data-use terms gate content: the Gemini route is refused for sensitive workloads (`sensitiveDataAllowed: false`).
- The ledger is the evidence: every reserve/settle/release is a row with units, period and workspace.
