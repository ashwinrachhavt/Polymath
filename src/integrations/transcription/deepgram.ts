import { z } from "zod";
import {
  TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionRequestError,
  TranscriptionUnconfiguredError,
  type TranscriptionProvider,
} from "./provider";

/*
 * Recorded-audio transcription through Deepgram's pre-recorded endpoint, billed
 * in seconds against the "deepgram" registry entry (a one-time credit). Every
 * request sends mip_opt_out=true, so audio is retained only while it is
 * processed; that is what lets the registry mark this route sensitive-safe.
 */

const ENDPOINT = "https://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";

const ResponseSchema = z.object({
  metadata: z.object({ duration: z.number() }),
  results: z.object({
    channels: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string() })).min(1) })).min(1),
  }),
});

export function deepgramTranscriptionProvider(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new TranscriptionUnconfiguredError();
  const model = env.DEEPGRAM_MODEL || DEFAULT_MODEL;
  return {
    name: `deepgram:${model}`,
    registryId: "deepgram",
    // Assumes at least 16 kbps audio (2000 bytes per second), so this over-reserves
    // and settlement against the reported duration corrects it.
    reserveUnits: ({ bytes }) => Math.max(1, Math.ceil(bytes.byteLength / 2000)),
    async transcribe({ bytes, mimeType }) {
      const params = new URLSearchParams({ model, language: "en", smart_format: "true", mip_opt_out: "true" });
      const response = await fetchImpl(`${ENDPOINT}?${params}`, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
      });
      if (!response.ok) throw new TranscriptionRequestError("deepgram", response.status);
      const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new TranscriptionRequestError("deepgram", response.status);
      return {
        text: parsed.data.results.channels[0].alternatives[0].transcript,
        units: Math.max(1, Math.ceil(parsed.data.metadata.duration)),
      };
    },
  };
}
