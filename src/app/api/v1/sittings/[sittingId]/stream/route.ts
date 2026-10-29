import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getSitting } from "@/domains/knowledge/sittings";
import {
  encodeSittingEvent,
  SITTING_PROTOCOL_VERSION,
  type SittingEvent,
} from "@/domains/knowledge/sitting-events";
import {
  durableEvents,
  executeCreationRun,
  getCreationRun,
  latestCreationRun,
  subscribeRun,
} from "@/domains/knowledge/sitting-run";

/*
 * GET /api/v1/sittings/:sittingId/stream — the sitting creation stream
 * (plan §3, §16.1). SSE-shaped NDJSON: durable events (allowlisted stage
 * outcomes on agent_steps) replay by cursor; live token/thinking events fan
 * out to attached connections and are never persisted.
 *
 * Execution is in-process: the FIRST attach to a running run drives the
 * stage pipeline within this connection's lifetime. A dropped connection
 * stops execution mid-flight; nothing committed is lost, and a reconnect
 * replays the durable record only (§14.7 corrected). A running run with no
 * live executor replays durable events and closes - the client may retry,
 * which sweeps or reuses per §16.9.
 *
 * A sitting in another workspace answers the same 404 as a missing one
 * (§16.9: same 404 shape as the existing route).
 */

type Ctx = { params: Promise<{ sittingId: string }> };

const CURSOR_HEADER = "x-sitting-cursor";

export const GET = authedHandler<Ctx>(async (auth, request, ctx) => {
  requireRole(auth, "member");
  const { sittingId } = await ctx.params;
  if (!z.string().uuid().safeParse(sittingId).success) return problemResponse(404, "not_found", "No such sitting.");
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) return problemResponse(404, "not_found", "No such sitting.");

  const rawCursor = request.headers.get(CURSOR_HEADER);
  const parsed = rawCursor === null ? 0 : Number(rawCursor);
  const cursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;

  const run = await latestCreationRun(auth, sittingId);
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
        if (!run) {
          push({ protocolVersion: SITTING_PROTOCOL_VERSION, operationId: "", event: "done" });
          return;
        }
        // 1. Replay the durable record from the cursor (§16.1).
        const steps = await durableEvents(auth, run.id, cursor);
        for (const step of steps) {
          const payload = (step.payload ?? {}) as Record<string, unknown>;
          push({
            protocolVersion: SITTING_PROTOCOL_VERSION,
            operationId: run.id,
            ...(typeof payload.artifactId === "string" ? { artifactId: payload.artifactId } : {}),
            ...(typeof payload.artifactVersionId === "string" ? { artifactVersionId: payload.artifactVersionId } : {}),
            event: (payload.event as SittingEvent["event"]) ?? "warning",
            payload,
          });
        }
        if (run.state !== "running") {
          push({ protocolVersion: SITTING_PROTOCOL_VERSION, operationId: run.id, event: "done" });
          return;
        }
        // 2. Attach live AND drive execution in-process (§16.1). Execution is
        // tied to this connection: abort stops the pipeline.
        const unsubscribe = subscribeRun(run.id, push);
        const full = await getCreationRun(auth, run.id);
        const subject = Array.isArray(full?.subjects) ? (full!.subjects as { artifactId?: string }[])[0] : undefined;
        const quotaAdmitted = (full?.policySnapshot as { quota?: { admitted?: boolean } } | null)?.quota?.admitted ?? false;
        if (subject?.artifactId) {
          const executing = executeCreationRun(auth, {
            runId: run.id,
            sittingId,
            artifactId: subject.artifactId,
            quotaAdmitted,
          }).catch(() => undefined).finally(() => {
            unsubscribe();
            if (!gone) {
              try { controller.close(); } catch { /* already closed */ }
            }
          });
          request.signal.addEventListener("abort", () => {
            gone = true;
            unsubscribe();
            void executing;
          });
          await executing;
        } else {
          unsubscribe();
          push({ protocolVersion: SITTING_PROTOCOL_VERSION, operationId: run.id, event: "error", payload: { code: "RUN_MALFORMED", message: "The sitting run is missing its card reference." } });
        }
      } catch {
        // A client disconnect or execution fault ends the stream; durable
        // events keep the record and the client reconnects from its cursor.
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
