import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getSitting, SittingError } from "@/domains/knowledge/sittings";
import {
  encodeSittingEvent,
  isSittingEventName,
  SITTING_PROTOCOL_VERSION,
  type SittingEvent,
} from "@/domains/knowledge/sitting-events";
import {
  durableEvents,
  executeCreationRun,
  getCreationRun,
  latestCreationRun,
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

  /*
   * A request carrying a cursor is a RECONNECT (review): it resolves the
   * sitting's existing creation run - running or finished - and replays it.
   * Starting a new run for a cursor request would apply the cursor to the
   * wrong history and re-run generation/quota. Only a cursor-less request
   * starts (or reuses) a run.
   */
  let runId: string;
  let driveExecution = false;
  if (cursor > 0) {
    const existing = await latestCreationRun(auth, sittingId);
    if (!existing) return problemResponse(404, "not_found", "No creation run to resume.");
    runId = existing.id;
  } else {
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
    runId = started.runId;
    driveExecution = !started.reused;
  }
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
      /*
       * Subscribe-before-replay (review): the listener registers BEFORE the
       * durable snapshot is read, buffering live frames; the replay then
       * covers everything up to the snapshot, and the buffer flushes with
       * sequence dedupe - an event committed between snapshot and subscribe
       * can no longer vanish, and one fanned out after its commit never
       * arrives twice. Live-only frames (null seq) are unrecoverable by
       * design (§16.1) and pass through.
       */
      let replayedThrough = cursor;
      let liveReady = false;
      const buffer: { event: SittingEvent; seq: number | null }[] = [];
      let onDone: (() => void) | null = null;
      const deliver = (event: SittingEvent, seq: number | null) => {
        if (seq !== null) {
          if (seq <= replayedThrough) return;
          replayedThrough = seq;
        }
        push(event);
        if (event.event === "done") onDone?.();
      };
      const unsubscribe = subscribeRun(runId, (event, seq) => {
        if (liveReady) deliver(event, seq);
        else buffer.push({ event, seq });
      });
      try {
        // 1. Durable replay from the cursor (§16.1: protocol events only).
        // agent_steps also carries non-protocol rows (kind:"model" usage);
        // replaying one would hand the reducer an event outside
        // SITTING_EVENTS, whose switch returns undefined and crashes the
        // writing surface. Skip any payload whose event is not in the family.
        for (const step of await durableEvents(auth, runId, cursor)) {
          const payload = (step.payload ?? {}) as Record<string, unknown>;
          const eventName = typeof payload.event === "string" ? payload.event : "";
          if (!isSittingEventName(eventName)) continue;
          deliver({
            protocolVersion: SITTING_PROTOCOL_VERSION,
            operationId: runId,
            ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
            ...(typeof payload.artifactVersionId === "string" ? { artifactVersionId: payload.artifactVersionId } : {}),
            event: eventName as SittingEvent["event"],
            payload,
          }, step.sequence);
        }
        liveReady = true;
        for (const pending of buffer) deliver(pending.event, pending.seq);
        buffer.length = 0;

        const run = await getCreationRun(auth, runId);
        if (!run || run.state !== "running") {
          push({ protocolVersion: SITTING_PROTOCOL_VERSION, operationId: runId, event: "done" });
          return;
        }
        if (!driveExecution) {
          // Attach (review): a reused or reconnected run stays OPEN - live
          // frames flow until the run's done event or the client aborts; the
          // old early return ran the finally and closed the stream instantly.
          await new Promise<void>((resolve) => {
            onDone = resolve;
            request.signal.addEventListener("abort", () => resolve());
          });
          return;
        }
        // 2. Only the connection that STARTED the run drives execution,
        // in-process, for this connection's lifetime (§16.1).
        const executing = executeCreationRun(auth, {
          runId,
          sittingId,
          artifactId: body.data.artifactId,
          signal: request.signal,
        }).catch(() => undefined);
        request.signal.addEventListener("abort", () => { gone = true; });
        await executing;
      } catch {
        // A client disconnect or execution fault ends the stream; the durable
        // record keeps every committed event for the reconnect's cursor.
      } finally {
        gone = true;
        unsubscribe();
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
