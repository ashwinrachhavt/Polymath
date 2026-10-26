import {
  TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionRequestError,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "./provider";

/*
 * Voice notes transcribe through the verified free-first Gemini route
 * (ASH-187): the same Developer API free tier and key the generation seam
 * uses, billed against the same registry id and quota ledger - no new
 * provider, no paid route. Audio rides as inline_data, and the model is the
 * registry-verified cheap one.
 *
 * The free-tier caveat the registry entry carries applies unchanged: prompts
 * may be used to improve Google products, and this route only ever sees
 * non-sensitive content. A voice note is the same class of material as the
 * capture text the enrichment ladder already sends.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const PROMPT =
  "Transcribe this audio exactly as spoken. Return only the transcript text - no labels, no timestamps, no commentary. If the audio carries no speech, return an empty response.";

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

export function geminiTranscriptionProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new TranscriptionUnconfiguredError();
  const model = env.GEMINI_TRANSCRIPTION_MODEL || env.GEMINI_MODEL || DEFAULT_MODEL;
  return {
    name: `gemini:${model}`,
    registryId: "gemini",
    async transcribe({ bytes, mimeType }) {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString("base64") } },
                { text: PROMPT },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
      if (!response.ok) throw new TranscriptionRequestError("gemini", response.status);
      const body = (await response.json().catch(() => null)) as GeminiResponse | null;
      const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      return { text };
    },
  };
}
