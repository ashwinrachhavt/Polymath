import type {
  StreamingSessionEvents,
  StreamingTranscriptionProvider,
  StreamingTranscriptionSession,
} from "./streaming";

/*
 * The Deepgram streaming adapter (issue #532): the Listen WebSocket API at
 * wss://api.deepgram.com/v1/listen, protocol implemented directly - no SDK
 * dependency - so the transport is injectable and the protocol is proven
 * against a faithful mock in tests. The contract, from Deepgram's own docs
 * (developers.deepgram.com/docs/live-streaming-audio and /docs/finalize):
 *
 * - Audio flows as binary frames; transcript frames arrive as JSON text:
 *   {"type":"Results", channel.alternatives[0].transcript, is_final,
 *    speech_final, from_finalize}. is_final=false hypotheses are interim;
 *   is_final=true commits a segment.
 * - {"type":"Finalize"} flushes the server buffer: every recognized word
 *   returns as a final (the last carries from_finalize:true) - that is how
 *   stop() preserves trailing words instead of cutting them.
 * - {"type":"CloseStream"} ends the stream; the adapter then closes the
 *   socket. {"type":"KeepAlive"} prevents the server's inactivity timeout.
 * - Auth is `Authorization: Token <key>`; on WebSocket the key travels as
 *   the `token` subprotocol, which the injected socket factory wires.
 *
 * The key comes only from DEEPGRAM_API_KEY, read when the explicit provider
 * selector names deepgram (streaming.ts) - never from request input, never
 * logged. Missing key fails loudly at construction. The adapter itself makes
 * no network call until startSession runs inside a request the app chose to
 * serve; enabling that in production, and the first billable second, is the
 * credits-trial gate the owner holds.
 */

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";
/** Deepgram closes idle sockets; keep them warm well under that window. */
const KEEPALIVE_MS = 8_000;
/** stop() waits this long for the Finalize flush before closing anyway. */
const FINALIZE_TIMEOUT_MS = 5_000;
/** Audio arriving before the socket opens buffers up to this many bytes. */
const MAX_BUFFERED_BYTES = 1_048_576;

/** The slice of the WebSocket the adapter speaks, so tests inject a mock. */
export interface DeepgramSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
}

export type DeepgramSocketFactory = (url: string, protocols: string[]) => DeepgramSocket;

export type DeepgramStreamingOptions = {
  /** DEEPGRAM_API_KEY. Read here and nowhere else. */
  apiKey: string;
  model?: string;
  /** Extra listen query parameters (encoding, sample_rate, endpointing...). */
  query?: Record<string, string>;
  socketFactory: DeepgramSocketFactory;
};

class DeepgramApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramApiError";
  }
}

function listenUrl(model: string, query: Record<string, string>): string {
  const params = new URLSearchParams({
    model,
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    ...query,
  });
  return `${LISTEN_URL}?${params.toString()}`;
}

export function deepgramStreamingTranscriptionProvider(
  overrides: Partial<DeepgramStreamingOptions> = {},
): StreamingTranscriptionProvider {
  const apiKey = overrides.apiKey ?? process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "TRANSCRIPTION_STREAMING_PROVIDER=deepgram requires DEEPGRAM_API_KEY in the environment.",
    );
  }
  const model = overrides.model ?? process.env.DEEPGRAM_MODEL?.trim() ?? DEFAULT_MODEL;
  const socketFactory =
    overrides.socketFactory ??
    (((url, protocols) => {
      // Node 22+ and browsers both expose a global WebSocket; the factory
      // indirection is what keeps the protocol testable without a network.
      const Ctor = (globalThis as { WebSocket?: new (u: string, p?: string[]) => DeepgramSocket })
        .WebSocket;
      if (!Ctor) {
        throw new Error("No WebSocket implementation available for the Deepgram transport.");
      }
      return new Ctor(url, protocols);
    }) satisfies DeepgramSocketFactory);

  return {
    name: `deepgram:${model}`,
    registryId: "deepgram",
    async startSession(events: StreamingSessionEvents): Promise<StreamingTranscriptionSession> {
      const socket = socketFactory(listenUrl(model, overrides.query ?? {}), ["token", apiKey]);
      let buffered: Uint8Array[] = [];
      let bufferedBytes = 0;
      let open = false;
      let settled = false;
      let sawFinalizedFlush = false;
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      let finalizeTimer: ReturnType<typeof setTimeout> | null = null;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        events.onError?.(error);
      };

      // The session is returned before the socket opens; audio sent early
      // buffers (bounded) and flushes on open, and a failed open surfaces
      // through onError like any other transport failure.
      socket.onopen = () => {
        open = true;
        for (const chunk of buffered) socket.send(chunk);
        buffered = [];
        bufferedBytes = 0;
        keepAlive = setInterval(() => {
          try {
            socket.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {
            /* a dead socket reports through onclose/onerror */
          }
        }, KEEPALIVE_MS);
      };
      socket.onerror = () => fail(new DeepgramApiError("Deepgram listen socket failed."));

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let frame: {
          type?: string;
          channel?: { alternatives?: { transcript?: string }[] };
          is_final?: boolean;
          from_finalize?: boolean;
          description?: string;
        };
        try {
          frame = JSON.parse(event.data) as typeof frame;
        } catch {
          return; // Deepgram sends no non-JSON text frames; ignore anything else.
        }
        if (frame.type === "Error") {
          fail(new DeepgramApiError(frame.description ?? "Deepgram reported an error frame."));
          return;
        }
        if (frame.type !== "Results") return; // Metadata, UtteranceEnd: not transcript text.
        const text = frame.channel?.alternatives?.[0]?.transcript ?? "";
        if (frame.from_finalize) sawFinalizedFlush = true;
        if (frame.is_final) {
          if (text) events.onFinal?.({ text, trailing: false });
        } else {
          events.onInterim?.(text);
        }
      };
      socket.onclose = (event) => {
        if (keepAlive) clearInterval(keepAlive);
        if (settled) return;
        // A clean close after CloseStream is the normal end; anything else is a drop.
        if (!event.wasClean) {
          fail(
            new DeepgramApiError(
              `Deepgram listen socket closed unexpectedly (code ${event.code ?? "unknown"}).`,
            ),
          );
        }
      };

      const teardown = () => {
        if (keepAlive) clearInterval(keepAlive);
        if (finalizeTimer) clearTimeout(finalizeTimer);
      };

      const session: StreamingTranscriptionSession = {
        sendAudio(chunk: Uint8Array) {
          if (settled) return;
          if (!open) {
            bufferedBytes += chunk.byteLength;
            if (bufferedBytes > MAX_BUFFERED_BYTES) {
              fail(new DeepgramApiError("Deepgram socket did not open; audio buffer overflowed."));
              return;
            }
            buffered.push(chunk);
            return;
          }
          socket.send(chunk);
        },
        async stop() {
          // Finalize flushes the server buffer so the trailing words return
          // as finals; CloseStream then ends the stream and we close.
          if (open) {
            socket.send(JSON.stringify({ type: "Finalize" }));
            await new Promise<void>((resolve) => {
              finalizeTimer = setTimeout(resolve, FINALIZE_TIMEOUT_MS);
              const poll = setInterval(() => {
                if (sawFinalizedFlush) {
                  clearInterval(poll);
                  if (finalizeTimer) clearTimeout(finalizeTimer);
                  resolve();
                }
              }, 20);
            });
            socket.send(JSON.stringify({ type: "CloseStream" }));
          }
          teardown();
          settled = true;
          socket.close();
        },
        cancel() {
          if (open) socket.send(JSON.stringify({ type: "CloseStream" }));
          teardown();
          settled = true;
          socket.close();
        },
      };
      return session;
    },
  };
}
