import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { problemResponse } from "@/lib/problems";
import { eveAgentForProfile, eveBridgeUnavailableReason, eveSessionEndpoint } from "@/domains/agents/eve-driver";
import { getProfileNameForRun } from "@/domains/agents/queries";
import { agentRuns } from "@/domains/agents/schema";
import { isFinished } from "@/domains/agents/thread";
import {
  decodeFrame,
  encodeFrame,
  frameOf,
  splitLines,
  type ChatFrame,
} from "@/domains/agents/stream-contract";

/*
 * GET /api/v1/runs/:runId/stream — the chat surface's one streaming endpoint.
 *
 * The browser cannot call Eve directly: every Eve request needs a 60-second
 * bridge token minted server-side (bridge-token.ts). So this route authenticates
 * the caller, resolves the run's Eve session_ref in the caller's workspace,
 * opens Eve's durable NDJSON stream, and re-frames it into ChatFrame lines.
 *
 * Why proxy rather than hand the browser a token: a token that outlived the
 * request would be a standing grant for the workspace, and minting one per
 * reconnect from the browser would mean shipping the secret. The proxy keeps
 * the secret server-side and re-mints per connection.
 *
 * Reconnect: `startIndex` is Eve's absolute event count, and `meta.id` is stable
 * across replays. The client sends back the highest cursor it has applied, so a
 * dropped connection resumes instead of restarting. A replayed event is also
 * idempotent locally (ChatAccumulator keys deltas by block and cursor), so an
 * overlapping replay renders once.
 */

type Ctx = { params: Promise<{ runId: string }> };

const CURSOR_HEADER = "x-chat-cursor";

export const GET = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { runId } = await ctx.params;
  if (!z.string().uuid().safeParse(runId).success) return problemResponse(404, "not_found", "No such run.");

  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return problemResponse(503, "agent_bridge_unavailable", unavailable);

  const [run] = await db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      sessionRef: agentRuns.sessionRef,
      agentProfileId: agentRuns.agentProfileId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, auth.workspaceId)))
    .limit(1);
  // A run in another workspace answers the same 404 as a missing one.
  if (!run) return problemResponse(404, "not_found", "No such run.");

  // The cursor the client has already applied. Eve's startIndex is an absolute
  // event count, so this is a count, not an event id.
  const rawCursor = request.headers.get(CURSOR_HEADER);
  const parsedCursor = rawCursor === null ? 0 : Number.parseInt(rawCursor, 10);
  const startIndex = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;

  const emit = (frame: ChatFrame) => encodeFrame(frame);

  // A finished run has nothing live to follow. Replay its durable tail instead
  // of holding a connection open forever.
  const finished = isFinished(run.state);
  if (!run.sessionRef) {
    // The run exists but Eve never allocated a session (start failed before
    // create). Say so as a frame rather than a transport error: the surface
    // shows it inside the chat.
    return ndjsonResponse([
      emit({ type: "error", runId, code: "stream_unavailable", message: "This run has no agent session.", cursor: startIndex }),
      emit({ type: "end", runId, state: run.state === "cancelled" ? "cancelled" : "failed", cursor: startIndex }),
    ]);
  }

  const profileName = await getProfileNameForRun(auth.workspaceId, run.id);
  const endpoint = eveSessionEndpoint({
    agentName: eveAgentForProfile(profileName ?? "alfred"),
    sessionRef: run.sessionRef,
    auth,
    startIndex,
    follow: !finished,
  });

  let upstream: Response;
  try {
    upstream = await fetch(endpoint.url, {
      headers: endpoint.headers,
      signal: request.signal,
      // A stream must not be buffered or cached by a proxy.
      cache: "no-store",
    });
  } catch {
    return ndjsonResponse([
      emit({ type: "error", runId, code: "stream_unavailable", message: "The agent stream is unreachable.", cursor: startIndex }),
    ]);
  }

  if (!upstream.ok || !upstream.body) {
    // A finished session can answer 409 session_stranded; either way the
    // surface gets a frame it can render instead of a bare 5xx.
    return ndjsonResponse([
      emit({
        type: "error",
        runId,
        code: "stream_unavailable",
        message: `The agent stream returned ${upstream.status}.`,
        cursor: startIndex,
      }),
      ...(finished ? [emit({ type: "end" as const, runId, state: "succeeded" as const, cursor: startIndex })] : []),
    ]);
  }

  // Re-frame: read NDJSON lines out of Eve, map each event to ChatFrames.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let buffer = "";
      let cursor = startIndex;
      let closed = false;
      const push = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += new TextDecoder().decode(chunk, { stream: true });
          const { lines, rest } = splitLines(buffer);
          buffer = rest;
          for (const line of lines) {
            const event = decodeEveEvent(line);
            if (!event) continue;
            for (const frame of frameOf(runId, event, cursor)) push(encodeFrame(frame));
            cursor += 1;
            if (event.type === "session.completed" || event.type === "session.failed") {
              // Terminal: stop following rather than waiting for the lease.
              closed = true;
            }
          }
          if (closed) break;
        }
        // A trailing line without its newline still carries an event.
        const tail = decodeEveEvent(buffer);
        if (tail) for (const frame of frameOf(runId, tail, cursor)) push(encodeFrame(frame));
      } catch {
        // A client disconnect or upstream reset ends the read; the durable
        // stream keeps the events, and the client reconnects from its cursor.
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }
    },
    cancel() {
      // The consumer went away; dropping the read lets fetch release upstream.
      void upstream.body?.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

/** Eve's envelope: `{ type, data, meta }`. Anything else is skipped, not fatal. */
function decodeEveEvent(line: string): { type: string; data?: Record<string, unknown>; meta?: { id?: string } } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown; data?: unknown; meta?: unknown };
    if (typeof parsed.type !== "string") return null;
    return {
      type: parsed.type,
      data: (parsed.data ?? undefined) as Record<string, unknown> | undefined,
      meta: (parsed.meta ?? undefined) as { id?: string } | undefined,
    };
  } catch {
    return null;
  }
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join(""), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

// `decodeFrame` is re-exported for the client store's tests; keeping the import
// here documents that the route and the store share one decoder.
export { decodeFrame };
