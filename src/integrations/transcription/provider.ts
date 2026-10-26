/*
 * The one shape transcription adapters implement (ASH-298), mirroring the
 * generation seam (ASH-187): a voice capture's audio becomes the transcript
 * that the ordinary capture enrichment ladder then classifies - same tiers,
 * same proposals, no parallel pipeline.
 *
 * Selection is EXPLICIT and only explicit: TRANSCRIPTION_PROVIDER names the
 * adapter, and without it the seam answers "unconfigured" - a new live-model
 * capability never activates itself by detecting a key. The fixture is
 * selectable only by the same explicit choice, so no deployment drifts into
 * fake transcripts, and no production capture silently shows invented words:
 * unconfigured is surfaced on the capture, never papered over.
 */

export type TranscribeInput = {
  bytes: Uint8Array;
  /** The sniffed content type (audio/webm, audio/mp4, ...), never the client's claim. */
  mimeType: string;
};

export interface TranscriptionProvider {
  /** Recorded as the transcriber, e.g. "gemini:gemini-3.5-flash-lite". */
  readonly name: string;
  /** The registry id used for quota admission, e.g. "gemini". */
  readonly registryId: string;
  transcribe(input: TranscribeInput): Promise<{ text: string }>;
}

export class TranscriptionUnconfiguredError extends Error {
  constructor() {
    super("No transcription provider configured. Set TRANSCRIPTION_PROVIDER to enable audio capture transcription.");
    this.name = "TranscriptionUnconfiguredError";
  }
}

export class TranscriptionRequestError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`Transcription request failed (${provider}, HTTP ${status})`);
    this.name = "TranscriptionRequestError";
  }
}

/** One call never hangs a run; audio understands slower than text. */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;

import { fixtureTranscriptionProvider } from "./fixture";
import { geminiTranscriptionProvider } from "./gemini";

export function transcriptionProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): TranscriptionProvider {
  const choice = env.TRANSCRIPTION_PROVIDER?.toLowerCase();
  if (choice === "fixture") return fixtureTranscriptionProvider();
  if (choice === "gemini") return geminiTranscriptionProvider(env, fetchImpl);
  if (choice) throw new TranscriptionRequestError(choice, 0);
  throw new TranscriptionUnconfiguredError();
}
