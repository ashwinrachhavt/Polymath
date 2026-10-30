import {
  GENERATION_TIMEOUT_MS,
  GenerationRequestError,
  GenerationUnconfiguredError,
  type GenerateInput,
  type GenerationProvider,
  type StreamChunk,
} from "./provider";
import { sseLines } from "./sse";

/*
 * The verified free-first generation route (ASH-187): the Gemini Developer
 * API's free tier. Free-of-charge input/output confirmed 2026-10-19 for
 * gemini-3.5-flash-lite (the default: the cheap high-volume model) and
 * gemini-3.8-flash against https://ai.google.dev/gemini-api/docs/pricing.
 *
 * Two caveats the registry entry carries, repeated here because they change
 * what callers may send:
 * - Free-tier prompts and responses may be used to improve Google products,
 *   so sensitiveDataAllowed is false. Deterministic code handles what is
 *   sensitive; this route only ever sees non-sensitive text.
 * - Google Search grounding is not available on the free tier. Web evidence
 *   comes from the search seam, not from asking the model to browse.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

export function geminiProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): GenerationProvider {
  const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new GenerationUnconfiguredError();
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  return {
    name: `gemini:${model}`,
    registryId: "gemini",
    async generate(input: GenerateInput) {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: {
            temperature: input.temperature ?? 0,
            ...(input.json ? { responseMimeType: "application/json" } : {}),
          },
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      // Provider error text is not kept: status only.
      if (!response.ok) throw new GenerationRequestError("gemini", response.status);
      const body = (await response.json().catch(() => null)) as GeminiResponse | null;
      const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return {
        text,
        usage: { inputTokens: body?.usageMetadata?.promptTokenCount, outputTokens: body?.usageMetadata?.candidatesTokenCount },
      };
    },
    async *stream(input: GenerateInput): AsyncGenerator<StreamChunk> {
      const response = await fetchImpl(`${ENDPOINT}/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: { temperature: input.temperature ?? 0 },
        }),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      if (!response.ok) throw new GenerationRequestError("gemini", response.status);
      if (!response.body) return;
      for await (const data of sseLines(response.body)) {
        try {
          const parsed = JSON.parse(data) as GeminiResponse;
          if (parsed.usageMetadata) {
            yield { type: "usage", usage: { inputTokens: parsed.usageMetadata.promptTokenCount, outputTokens: parsed.usageMetadata.candidatesTokenCount } };
          }
          const text = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
          if (text) yield { type: "token", content: text };
        } catch {
          // A malformed SSE frame skips; the stream contract stays line-shaped.
        }
      }
    },
  };
}
