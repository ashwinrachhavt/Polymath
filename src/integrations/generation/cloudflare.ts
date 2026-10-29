import {
  GENERATION_TIMEOUT_MS,
  GenerationConfigError,
  GenerationRequestError,
  chatMessages,
  type GenerateInput,
  type GenerationProvider,
  type StreamChunk,
} from "./provider";
import { sseLines } from "./sse";

/*
 * Cloudflare Workers AI (plan 2026-10-29 §8): an opt-in generation route,
 * selected only by GENERATION_PROVIDER=cloudflare. The free-first default
 * chain (Gemini -> OpenRouter, owner decision 2026-10-27) is untouched.
 *
 * The adapter is thin: quota admission happens per run at the call site,
 * per-call usage rides the metered() wrapper. Configuration fails fast at
 * selection (§15.6): a missing variable raises GenerationConfigError naming
 * the variable and the value to set, never a mid-stream surprise.
 */

const ENDPOINT = (account: string, model: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`;

type CfUsage = { prompt_tokens?: number; completion_tokens?: number };
type CfResponse = { result?: { response?: string; usage?: CfUsage }; success?: boolean };

export function cloudflareProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): GenerationProvider {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    throw new GenerationConfigError("CLOUDFLARE_ACCOUNT_ID", "your Cloudflare account ID, from the dashboard URL or `wrangler whoami`");
  }
  const apiKey = env.CLOUDFLARE_API_KEY;
  if (!apiKey) {
    throw new GenerationConfigError("CLOUDFLARE_API_KEY", "an API token with Workers AI access");
  }
  const model = env.CLOUDFLARE_MODEL;
  if (!model) {
    throw new GenerationConfigError("CLOUDFLARE_MODEL", "a Workers AI model id, e.g. @cf/meta/llama-3.1-8b-instruct");
  }
  const url = ENDPOINT(account, model);
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  return {
    name: `cloudflare:${model}`,
    registryId: "cloudflare-workers-ai",
    async generate(input: GenerateInput) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: chatMessages(input),
          temperature: input.temperature ?? 0,
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      // Provider error text is not kept: status only (credentials never in logs).
      if (!response.ok) throw new GenerationRequestError("cloudflare", response.status);
      const body = (await response.json().catch(() => null)) as CfResponse | null;
      return {
        text: body?.result?.response ?? "",
        usage: { inputTokens: body?.result?.usage?.prompt_tokens, outputTokens: body?.result?.usage?.completion_tokens },
      };
    },
    async *stream(input: GenerateInput): AsyncGenerator<StreamChunk> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: chatMessages(input),
          temperature: input.temperature ?? 0,
          stream: true,
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new GenerationRequestError("cloudflare", response.status);
      if (!response.body) return;
      for await (const data of sseLines(response.body)) {
        try {
          const parsed = JSON.parse(data) as { response?: string };
          if (parsed.response) yield { type: "token", content: parsed.response };
        } catch {
          // A malformed SSE frame skips; the stream contract stays line-shaped.
        }
      }
    },
  };
}
