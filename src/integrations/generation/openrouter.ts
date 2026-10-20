import {
  GENERATION_TIMEOUT_MS,
  GenerationRequestError,
  GenerationUnconfiguredError,
  type GenerateInput,
  type GenerationProvider,
} from "./provider";

/*
 * The status-quo generation route: the workspace's own OpenRouter key. This
 * is a paid route the workspace already funds, not a free allowance — the
 * registry marks it "paid", and the seam never selects it as a rescue when a
 * free route is exhausted; it runs only when configured explicitly or when it
 * is the only key present (the pre-ASH-187 default).
 */

const URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

type OpenRouterResponse = { choices?: Array<{ message?: { content?: string } }> };

export function openRouterProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  modelOverride?: string,
): GenerationProvider {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new GenerationUnconfiguredError();
  const model = modelOverride || env.GENERATION_MODEL || DEFAULT_MODEL;
  return {
    name: `openrouter:${model}`,
    registryId: "openrouter",
    async generate(input: GenerateInput) {
      const response = await fetchImpl(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
          temperature: input.temperature ?? 0,
          messages: [
            ...(input.system ? [{ role: "system", content: input.system }] : []),
            { role: "user", content: input.prompt },
          ],
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      // Provider error text is not kept: status only.
      if (!response.ok) throw new GenerationRequestError("openrouter", response.status);
      const body = (await response.json().catch(() => null)) as OpenRouterResponse | null;
      return { text: body?.choices?.[0]?.message?.content ?? "" };
    },
  };
}
