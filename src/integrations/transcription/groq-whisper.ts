/*
 * Speech to timed text through Groq's hosted Whisper (whisper-large-v3-turbo),
 * the cheapest good transcriber available to us: $0.04 per hour of audio,
 * billed per second with a 10 second minimum per request. Used where a video
 * has no captions. One call transcribes one clip; the caller splits long
 * audio into clips (Groq refuses files over 25 MB on the free tier).
 *
 * GROQ_API_KEY turns it on; without it the caller reports that speech
 * transcription is not set up. The key is sent to Groq only.
 */

const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Groq's list price for whisper-large-v3-turbo: $0.04 per hour, in millionths of a dollar. */
const MICRO_USD_PER_HOUR = 40_000;
const MINIMUM_BILLED_SECONDS = 10;
const TIMEOUT_MS = 120_000;

export type SpeechSegment = { start: number; end: number; text: string };

export type AudioClip = { bytes: Uint8Array; mimeType: string; filename: string };

class SpeechTranscriptionError extends Error {
  constructor(readonly status: number) {
    super(`Groq transcription failed (HTTP ${status})`);
    this.name = "SpeechTranscriptionError";
  }
}

/** What Groq charges for a clip of this length, in millionths of a dollar. */
export function groqWhisperCostMicroUsd(seconds: number): number {
  return Math.ceil((Math.max(MINIMUM_BILLED_SECONDS, seconds) / 3600) * MICRO_USD_PER_HOUR);
}

export function groqWhisperConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.GROQ_API_KEY?.trim());
}

type VerboseJson = { duration?: number; segments?: Array<{ start?: number; end?: number; text?: string }> };

/**
 * Transcribes one clip. Segment times are seconds from the clip's start.
 * Throws SpeechTranscriptionError on a non-ok answer and lets a network
 * failure or abort through.
 */
export async function transcribeClipWithGroq(
  clip: AudioClip,
  options: {
    signal?: AbortSignal;
    language?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ segments: SpeechSegment[]; durationSeconds: number; costMicroUsd: number }> {
  const env = options.env ?? process.env;
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw new SpeechTranscriptionError(0);
  const form = new FormData();
  form.append("file", new Blob([clip.bytes as BlobPart], { type: clip.mimeType }), clip.filename);
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  if (options.language) form.append("language", options.language);
  const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
  const response = await (options.fetchImpl ?? fetch)(GROQ_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) throw new SpeechTranscriptionError(response.status);
  const body = (await response.json().catch(() => null)) as VerboseJson | null;
  const segments = (body?.segments ?? [])
    .map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? segment.start ?? 0),
      text: (segment.text ?? "").trim(),
    }))
    .filter((segment) => segment.text.length > 0 && Number.isFinite(segment.start));
  const durationSeconds = Number(body?.duration ?? segments.at(-1)?.end ?? 0);
  return { segments, durationSeconds, costMicroUsd: groqWhisperCostMicroUsd(durationSeconds) };
}
