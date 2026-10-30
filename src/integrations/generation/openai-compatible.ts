import {
  GENERATION_TIMEOUT_MS,
  GenerationRequestError,
  chatMessages,
  type GenerateInput,
  type GenerationProvider,
  type StreamChunk,
} from "./provider";
import { sseLines } from "./sse";

/*
 * The one OpenAI-wire-format adapter. Every chat/completions-shaped provider
 * (Mercury, OpenRouter, OpenAI, Anthropic's OpenAI-compat endpoint, a LiteLLM
 * proxy) is this function plus a catalog entry — a new provider is data, not
 * a new hand-rolled fetch/stream/parse. The native Gemini route stays its own
 * adapter: its wire format differs and it is the verified free-first route.
 *
 * Wire contract (OpenAI chat completions): POST {baseUrl}/chat/completions
 * with Bearer auth; non-stream returns usage {prompt_tokens,
 * completion_tokens}; stream=true returns SSE data frames ending in [DONE],
 * with stream_options.include_usage asking for a terminal usage frame.
 * Reasoning deltas (delta.reasoning) surface as thinking chunks; answer text
 * as token chunks.
 */

export type OpenAICompatibleConfig = {
  /** Base URL without the /chat/completions suffix, e.g. https://api.inceptionlabs.ai/v1 */
  baseUrl: string;
  apiKey: string;
  /** The `model` field sent in every request body. */
  model: string;
  /** Registry id for quota admission, e.g. "mercury". */
  registryId: string;
  /** Extra headers a provider requires (e.g. anthropic-version). */
  headers?: Record<string, string>;
  /** Ask for the terminal usage frame on streams (OpenRouter-style). */
  streamUsage?: boolean;
};

type CompletionResponse = {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string; reasoning?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function openAICompatibleProvider(
  config: OpenAICompatibleConfig,
  fetchImpl: typeof fetch = fetch,
): GenerationProvider {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    ...config.headers,
  };
  return {
    name: `${config.registryId}:${config.model}`,
    registryId: config.registryId,
    async generate(input: GenerateInput) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: chatMessages(input),
          temperature: input.temperature ?? 0,
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      // Provider error text is not kept: status only (credentials never in logs).
      if (!response.ok) throw new GenerationRequestError(config.registryId, response.status);
      const body = (await response.json().catch(() => null)) as CompletionResponse | null;
      return {
        text: body?.choices?.[0]?.message?.content ?? "",
        usage: { inputTokens: body?.usage?.prompt_tokens, outputTokens: body?.usage?.completion_tokens },
      };
    },
    async *stream(input: GenerateInput): AsyncGenerator<StreamChunk> {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: chatMessages(input),
          temperature: input.temperature ?? 0,
          stream: true,
          ...(config.streamUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new GenerationRequestError(config.registryId, response.status);
      if (!response.body) return;
      for await (const data of sseLines(response.body)) {
        try {
          const parsed = JSON.parse(data) as CompletionResponse;
          if (parsed.usage) {
            yield { type: "usage", usage: { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } };
            continue;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning) yield { type: "thinking", content: delta.reasoning };
          if (delta?.content) yield { type: "token", content: delta.content };
        } catch {
          // A malformed SSE frame skips; the stream contract stays line-shaped.
        }
      }
    },
  };
}
