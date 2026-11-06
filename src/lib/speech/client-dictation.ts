import type { FinalTranscript } from "@/integrations/transcription/streaming";

/*
 * The browser half of dictation (issue #532): the controller owns state and
 * insertion; this contract is how a client session gets transcripts. The
 * provider key never touches the browser - audio rides to our own API route
 * as encoded chunks, and the route is the only place the server-side
 * streaming provider (fixture today, Deepgram behind the explicit env gate)
 * is constructed.
 */

export type ClientDictationEvents = {
  onInterim?: (text: string) => void;
  onFinal?: (segment: FinalTranscript) => void;
  onError?: (error: Error) => void;
};

export interface ClientDictationSession {
  stop(): Promise<void>;
  cancel(): void;
}

export interface ClientDictationProvider {
  readonly name: string;
  startSession(events: ClientDictationEvents, stream: MediaStream): Promise<ClientDictationSession>;
}

type SseFrame =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string; trailing: boolean }
  | { kind: "error"; message: string };

/** Parse one SSE buffer into frames, returning the unparsed remainder. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary === -1) break;
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      frames.push(JSON.parse(data) as SseFrame);
    } catch {
      // A malformed frame is skipped, not fatal: the stream stays live.
    }
  }
  return { frames, rest };
}

/**
 * Dictation through POST /api/v1/dictation: MediaRecorder chunks stream up as
 * the request body, transcript frames stream back as SSE. stop() ends the
 * upload and waits out the server's Finalize flush so trailing words land;
 * cancel() aborts the whole exchange.
 */
export function apiDictationProvider(endpoint = "/api/v1/dictation"): ClientDictationProvider {
  return {
    name: "api:dictation",
    async startSession(events, stream) {
      const abort = new AbortController();
      let cancelled = false;
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      let uploadController: ReadableStreamDefaultController<Uint8Array> | null = null;

      const upload = new ReadableStream<Uint8Array>({
        start(controller) {
          uploadController = controller;
          recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;
            event.data.arrayBuffer().then((buffer) => {
              try {
                controller.enqueue(new Uint8Array(buffer));
              } catch {
                /* stream closed underneath a late chunk */
              }
            });
          };
          recorder.onerror = () => {
            try {
              controller.error(new Error("MediaRecorder failed."));
            } catch {
              /* already closed */
            }
          };
        },
      });

      const responsePromise = fetch(endpoint, {
        method: "POST",
        body: upload,
        // Required for a streaming request body; unsupported browsers throw here.
        duplex: "half",
        headers: { "content-type": "audio/webm" },
        signal: abort.signal,
      } as RequestInit);

      const response = await responsePromise;
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Dictation is unavailable (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }

      const finished = (async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = parseSseFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
              if (cancelled) return;
              if (frame.kind === "interim") events.onInterim?.(frame.text);
              else if (frame.kind === "final") events.onFinal?.({ text: frame.text, trailing: frame.trailing });
              else events.onError?.(new Error(frame.message));
            }
          }
        } catch (error) {
          if (!cancelled && !abort.signal.aborted) {
            events.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      })();

      recorder.start(250);
      return {
        async stop() {
          // End the upload; the server flushes its trailing words and ends
          // the SSE stream, and `finished` resolves once they all landed.
          recorder.stop();
          try {
            uploadController?.close();
          } catch {
            /* already closed */
          }
          await finished;
        },
        cancel() {
          cancelled = true;
          recorder.stop();
          abort.abort();
        },
      };
    },
  };
}
