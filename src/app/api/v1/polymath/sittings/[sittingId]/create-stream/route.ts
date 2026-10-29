import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getSitting, SittingError } from "@/domains/knowledge/sittings";
import {
  encodeSittingEvent,
  SITTING_PROTOCOL_VERSION,
  type SittingEvent,
} from "@/domains/knowledge/sitting-events";
import {
  durableEvents,
  executeCreationRun,
  getCreationRun,
  startCreationRun,
  subscribeRun,
} from "@/domains/knowledge/sitting-run";

/*
 * POST /api/v1/polymath/sittings/:sittingId/create-stream — the named
 * creation-stream endpoint (plan §16.6). One endpoint owns the lifecycle:
 * start-or-reuse the sitting's single creation run (§16.9 cap, §16.4 quota
 * admission at start, never per attach), then stream NDJSON back.
 *
 * Reconnect: the client resends with its cursor header; a reused run replays
 * its durable events from the cursor (§14.7 corrected: durable events only -
 * tokens/thinking are unrecoverable by design, §16.1). Execution is
 * in-process: this connection drives the stage pipeline for a run it
 * started; a reused run that is already being driven by another live
 * connection is attached to, not re-executed.
 *
 * Explicitly NO eveBridgeUnavailableReason guard (§16.6): creation runs have
 * no Eve session; a bridge outage must not 503 this stream.
 */

type Ctx = { params: Promise<{ sittingId: string }> };

const CURSOR_HEADER = "x-sitting-cursor";
const Body = z.object({ artifactId: z.string().uuid() });

export const POST = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { sittingId } = await ctx.params;
  if (!z.string().uuid().safeParse(sittingId).success) return problemResponse(404, "not_found", "No such sitting.");
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) return problemResponse(404, "not_found", "No such sitting.");
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse(400, "invalid_body", "artifactId (uuid) is required.");

  const rawCursor = request.headers.get(CURSOR_HEADER);
  const parsed = rawCursor === null ? 0 : Number(rawCursor);
  const cursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;

  let started: Awaited<ReturnType<typeof startCreationRun>>;
  try {
    started = await startCreationRun(auth, { sittingId, artifactId: body.data.artifactId });
  } catch (cause) {
    // §15.4: typed domain errors render as the standard error surface,
    // never as SSE events (the join never happened).
    if (cause instanceof SittingError) {
      return problemResponse(
        cause.code === "ARTIFACT_WORKSPACE_MISMATCH" ? 403 : 404,
        cause.code.toLowerCase(),
        cause.message,
      );
    }
    throw cause;
  }

  const runId = started.runId;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let gone = false;
      const push = (event: SittingEvent) => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(encodeSittingEvent(event)));
        } catch {
          gone = true;
        }
      };
      try {
        // 1. Durable replay from the cursor (§16.1: allowlisted events only).
        for (const step of await durableEvents(auth, runId, cursor)) {
          const payload = (step.payload ?? {}) as Record<string, unknown>;
          push({
            protocolVersion: SITTING_PROTOCOL_VERSION,
            operationId: runId,
            ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
            ...(typeof payload.artifactVersionId === "string" ? { artifactVersionId: payload.artifactVersionId } : {}),
            event: (payload.event as SittingEvent["event"]) ?? "warning",
            payload,
          });
        }
        const run = await getCreationRun(auth, runId);
        if (!run || run.state !== "running") {
          push({ protocolVersion: SITTING_PROTOCOL_VERSION, operationId: runId, event: "done" });
          return;
        }
        // 2. Attach live; only the connection that STARTED the run drives
        // execution, in-process, for this connection's lifetime (§16.1).
        const unsubscribe = subscribeRun(runId, push);
        if (started.reused) {
          // Another connection owns execution, or the originator dropped and
          // the run is stranded-until-swept: durable replay above is the
          // contract; live attach delivers anything still arriving.
          request.signal.addEventListener("abort", () => { gone = true; unsubscribe(); });
          return;
        }
        const executing = executeCreationRun(auth, {
          runId,
          sittingId,
          artifactId: body.data.artifactId,
          quotaAdmitted: true,
        }).catch(() => undefined).finally(() => {
          unsubscribe();
          if (!gone) {
            try { controller.close(); } catch { /* already closed */ }
          }
        });
        request.signal.addEventListener("abort", () => {
          gone = true;
          unsubscribe();
        });
        await executing;
      } catch {
        // A client disconnect or execution fault ends the stream; the durable
        // record keeps every committed event for the reconnect's cursor.
      } finally {
        gone = true;
        try { controller.close(); } catch { /* already closed */ }
      }
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
