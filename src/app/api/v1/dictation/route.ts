import { NextResponse } from "next/server";
import { authedHandler } from "@/lib/auth";
import {
  streamingTranscriptionProvider,
  StreamingTranscriptionUnconfiguredError,
  type StreamingSessionEvents,
} from "@/integrations/transcription/streaming";

export const runtime = "nodejs";

/*
 * POST /api/v1/dictation — one dictation session (issue #532).
 *
 * The browser streams MediaRecorder chunks up as the request body; the
 * env-selected streaming provider (fixture today, Deepgram behind
 * TRANSCRIPTION_STREAMING_PROVIDER=deepgram + DEEPGRAM_API_KEY) transcribes;
 * interim and final frames stream back down as SSE. The provider key never
 * leaves the server. Unconfigured dictation is a 503 with the reason, not a
 * silent fallback: a paid provider never activates itself.
 *
 * When the upload ends (the user stopped) the server Finalize-flushes the
 * provider session, so the trailing words arrive as finals before the SSE
 * stream closes. Client abort cancels the provider session.
 */

type SseFrame =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string; trailing: boolean }
  | { kind: "error"; message: string };

function sse(frame: SseFrame): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
}

export const POST = authedHandler(async (_auth, request) => {
  let provider: ReturnType<typeof streamingTranscriptionProvider>;
  try {
    provider = streamingTranscriptionProvider();
  } catch (error) {
    const status = error instanceof StreamingTranscriptionUnconfiguredError ? 503 : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dictation is not configured." },
      { status },
    );
  }

  if (!request.body) {
    return NextResponse.json({ error: "Dictation requires a streaming audio body." }, { status: 400 });
  }

  const encoder = new TransformStream<Uint8Array, Uint8Array>();
  const writer = encoder.writable.getWriter();
  let cancelled = false;

  const events: StreamingSessionEvents = {
    onInterim: (text) => void writer.write(sse({ kind: "interim", text })).catch(() => {}),
    onFinal: (segment) =>
      void writer
        .write(sse({ kind: "final", text: segment.text, trailing: segment.trailing }))
        .catch(() => {}),
    onError: (error) =>
      void writer.write(sse({ kind: "error", message: error.message })).catch(() => {}),
  };

  let session;
  try {
    session = await provider.startSession(events);
  } catch {
    return NextResponse.json({ error: "The dictation provider failed to start." }, { status: 502 });
  }

  // Pump the upload into the provider; when the client closes the body the
  // session flushes its trailing words, then the SSE stream ends.
  void (async () => {
    const reader = request.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) session.sendAudio(value);
      }
      await session.stop();
    } catch {
      // The client went away mid-session: drop the provider session.
      cancelled = true;
      session.cancel();
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();

  request.signal.addEventListener("abort", () => {
    if (!cancelled) {
      cancelled = true;
      session.cancel();
    }
  });

  return new Response(encoder.readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-provider": provider.name,
    },
  });
});
