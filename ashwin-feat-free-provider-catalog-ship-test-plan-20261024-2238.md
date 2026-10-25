# Ship test plan — feat/free-provider-catalog

Branch: `feat/free-provider-catalog` · Date: 2026-10-24 · Framework: vitest

## Affected Pages/Routes

- Chat model picker (settings/profile model policy surface) — `availableModels()` filters `MODEL_CATALOG` by key env; picker now shows 23 entries across 9 providers.
- Agent run model resolution — `resolveModelId()` falls back to `DEFAULT_MODEL_ID` for retired ids.
- `webSearchProvider` selection — new `parallel` and `ai-gateway-{exa,tako,parallel,perplexity}` routes plus default-order insertion of `PARALLEL_API_KEY`.
- Provider registry — new disabled `ai-gateway-search` entry (paid search tools, consent-gated).
- Prompt surfaces — capture enrichment, wiki summarizer, zettel extractor, company research sections, research KPIs: shared `untrustedDataClause` injected into SYSTEM prompts; instructions/tool-description text changed in eve/alfred + eve/specialist.

## Key Interactions to Verify

1. Model picker: setting only one provider key shows exactly that provider's entries; no keys → empty picker, default still resolves.
2. Model picker: selecting a model, then clearing its key — stored id must resolve to default, never a dead id.
3. `SEARCH_PROVIDER=parallel` without `PARALLEL_API_KEY` throws `WebSearchError` loudly; with key, results normalize (title fallback to url, excerpts joined, publish_date nullable).
4. `SEARCH_PROVIDER=ai-gateway-exa` (etc.) routes to the gateway server tool; unknown suffix (`ai-gateway-altavista`) throws with the updated message.
5. Default chain order: `PARALLEL_API_KEY` alone picks parallel — verify it slots between firecrawl and brave, not after.
6. Agent chat grounding: answers cite corpus; prompt-injection text in a captured document is reported, not obeyed ([→EVAL] chat-grounding eval).

## Edge Cases

- `keyEnv` values are valid env-var names; all `baseUrl` https (unit-pinned).
- Gateway search returns content as string OR array-of-parts; empty content → `[]` not a fabricated result.
- Parallel hits without `url` are skipped; `publish_date` non-string → null.
- KPI extraction: no usable figures → `[]` exactly, never an estimated row; zettels verbatim-quote rule; summarizer thin-document path.
- Retired model id string stored in policy → default, non-string stored value → default.

## Critical Paths

- Model selection → run policy snapshot → execution (wrong resolution runs on the wrong model).
- Web search → agent research loop (timeout budgets: parallel 10s, gateway 30s).
- Capture enrichment SYSTEM prompt guards against injected instructions in captured content.

## Existing coverage

- ★★★ `tests/unit/model-catalog.test.ts` — catalog invariants, key filter, default resolution, retired-id fallback.
- ★★★ `tests/unit/web-search.test.ts` — selection matrix incl. new parallel/gateway branches, DDG parser, quota gating.
- ★★ `tests/unit/provider-registry.test.ts`, `zettel-extractor`, `research-kpis`, `company-research` — prompt surfaces tested through extraction/parse behavior (34 tests green).
- [→EVAL] `eve/alfred/evals/chat-grounding.eval.ts` — 2 passed, 7 gates, ran green 2026-10-24.

## Proposed tests (not written — audit only)

- parallelProvider + aiGatewaySearchProvider fetch paths against a stubbed fetch (shape normalization, empty-content, non-2xx → WebSearchError). Value: the two new adapters' HTTP/parsing logic is currently untested; only selection is.
- `untrustedDataClause` snapshot-in-string test per consumer. Value: guards against a future consumer dropping the clause.
