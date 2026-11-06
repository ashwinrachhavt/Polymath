/*
 * The streaming half of the transcription seam (issue #532): the existing
 * TranscriptionProvider contract stays for whole recordings (capture/uploads
 * -> enrichment), while prompt dictation needs a live session - interim
 * results as they arrive, final segments as they commit, and a stop that
 * preserves trailing words. The two contracts never share a transport:
 * dictation is NOT routed through capture enrichment.
 *
 * Selection is explicit and only explicit, mirroring provider.ts:
 * TRANSCRIPTION_STREAMING_PROVIDER names the adapter and without it the seam
 * answers "unconfigured" - a paid streaming session never activates itself
 * by detecting a key, and there is no silent paid fallback. The fixture is
 * selectable only by the same explicit choice, so no deployment drifts into
 * invented transcripts. Deepgram streaming lands with the credits trial
 * (the issue's $200 pilot credit; balance/expiry confirmation and spend are
 * the owner's gate) - until then naming "deepgram" fails loudly.
 */

import { fixtureStreamingTranscriptionProvider } from "./streaming-fixture";

/** One committed segment of the session: the words that will not change again. */
export type FinalTranscript = {
  text: string;
  /** True when this segment closed because the user stopped - the trailing words are preserved, not cut. */
  trailing: boolean;
};

export type StreamingSessionEvents = {
  /** The current uncommitted hypothesis; replaces the previous interim in full. */
  onInterim?: (text: string) => void;
  onFinal?: (segment: FinalTranscript) => void;
  onError?: (error: Error) => void;
};

export interface StreamingTranscriptionSession {
  /** Stop admitting new audio and flush: every recognized word still lands as a final (trailing) segment. */
  stop(): Promise<void>;
  /** Abandon the session: uncommitted interim is discarded and nothing further is delivered. */
  cancel(): void;
}

export interface StreamingTranscriptionProvider {
  /** Recorded as the transcriber, e.g. "deepgram:nova-3". */
  readonly name: string;
  /** The registry id used for quota admission, e.g. "deepgram". */
  readonly registryId: string;
  startSession(events: StreamingSessionEvents): Promise<StreamingTranscriptionSession>;
}

export class StreamingTranscriptionUnconfiguredError extends Error {
  constructor() {
    super(
      "No streaming transcription provider configured. Set TRANSCRIPTION_STREAMING_PROVIDER to enable prompt dictation.",
    );
    this.name = "StreamingTranscriptionUnconfiguredError";
  }
}

export function streamingTranscriptionProvider(): StreamingTranscriptionProvider {
  const selector = process.env.TRANSCRIPTION_STREAMING_PROVIDER?.trim();
  if (!selector) throw new StreamingTranscriptionUnconfiguredError();
  if (selector === "fixture") return fixtureStreamingTranscriptionProvider();
  if (selector === "deepgram") {
    throw new Error(
      "TRANSCRIPTION_STREAMING_PROVIDER=deepgram is not enabled yet: the Deepgram streaming adapter lands with the credits trial (issue #532). Confirm the credit balance and expiry first.",
    );
  }
  throw new Error(`TRANSCRIPTION_STREAMING_PROVIDER must be fixture or deepgram; got "${selector}".`);
}
