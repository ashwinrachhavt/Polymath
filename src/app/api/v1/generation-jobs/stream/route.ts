import { followGenerationJobs, parseJobCursor } from "@/domains/jobs/stream";
import { authedHandler } from "@/lib/auth";

/*
 * GET /api/v1/generation-jobs/stream — Server-Sent Events for the caller's
 * own generation jobs (see domains/jobs/stream.ts for the contract). Any
 * signed-in member may listen: the stream carries only jobs they made.
 */

export const maxDuration = 300;
/** Ends a little inside the platform limit, so the stream closes cleanly and the client reconnects with its cursor. */
const STREAM_MS = (maxDuration - 20) * 1000;

export const GET = authedHandler(async (auth, request) => {
  const frames = followGenerationJobs(auth, {
    since: parseJobCursor(request.headers.get("last-event-id")),
    signal: request.signal,
    maxMs: STREAM_MS,
  });
  const encoder = new TextEncoder();
  // Set when the client goes away: a read still in flight must not write to the closed stream.
  let gone = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<string>;
      try {
        next = await frames.next();
      } catch (cause) {
        // A failed read ends this connection; the client reconnects from its cursor.
        console.error("[generation-job] stream read failed", cause);
        next = { done: true, value: undefined };
      }
      if (gone) return;
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      gone = true;
      await frames.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
