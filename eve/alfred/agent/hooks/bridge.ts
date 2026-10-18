import { defineHook, type HookContext } from "eve/hooks";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths, so the alias does not resolve here.
import {
  closeRun,
  mirrorMessage,
  recordQuestion,
  recordRoundEvent,
  recordToolCall,
  recordUsageEvent,
} from "../../../../src/domains/agents/event-bridge";
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";

/*
 * The Axiom side of eve: this is the only file that imports eve, and its only
 * job is to forward eve's runtime stream events into the event bridge. Hooks
 * are observe-only (they cannot steer the model), which is exactly the seam the
 * bridge wants.
 *
 * Every handler is best-effort: a mirror write must never break the turn. A
 * failure is logged and swallowed here on purpose — the run table is a mirror,
 * eve's own stream stays authoritative, and a thrown hook error would fail the
 * user's turn over a bookkeeping write.
 *
 * eve allocates its own session ids (`wrun_…`), so the run id the bridge needs
 * comes from the run row whose `session_ref` is `ctx.session.id` — the driver
 * recorded it at start. An unknown session is skipped, not an error: schedule
 * and TUI sessions have no Axiom run to mirror into.
 */

/** The workspace the session belongs to, captured by the channel's AuthFn. */
function workspaceIdOf(ctx: HookContext): string | null {
  const value = ctx.session.auth.current?.attributes?.workspaceId;
  return typeof value === "string" ? value : null;
}

/** The Axiom run a session mirrors into, or null when the session has none. */
async function runIdOf(ctx: HookContext): Promise<string | null> {
  const workspaceId = workspaceIdOf(ctx);
  if (!workspaceId) return null;
  const run = await getRunBySessionRef(ctx.session.id, workspaceId);
  return run?.id ?? null;
}

/** Files headers and other opaque objects are stripped before a row is written. */
function failureDetail(event: { data: { code?: string; message?: string } }): string {
  const { code, message } = event.data;
  return [code, message].filter(Boolean).join(": ");
}

/*
 * Tool arguments arrive on `actions.requested`; the result arrives later on
 * `action.result` with no input. The call id is the join key, so inputs are
 * held here until their result lands.
 *
 * ponytail: process-local, unbounded map. Enough because a step's request and
 * result land in one session in one process. Move the store onto the run's
 * rows if a result ever outlives the process that requested it.
 */
const pendingInputs = new Map<string, unknown>();

async function guarded(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    console.error(`event bridge: ${label} failed`, cause);
  }
}

export default defineHook({
  events: {
    async "session.started"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("session.started", () =>
        recordRoundEvent({
          runId,
          workspaceId,
          type: "session.started",
          data: { at: event.meta.at },
        }),
      );
    },

    async "step.completed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      // Usage is what settlement sums; the step's coordinates are the dedupe key.
      if (event.data.usage) {
        await guarded("step.completed usage", () =>
          recordUsageEvent({
            runId,
            workspaceId,
            usage: event.data.usage as Record<string, unknown>,
            source: { turnId: event.data.turnId, stepIndex: event.data.stepIndex },
          }),
        );
      }
    },

    async "step.failed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("step.failed", () =>
        recordRoundEvent({
          runId,
          workspaceId,
          type: "step.failed",
          data: {
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
            detail: failureDetail(event),
          },
        }),
      );
    },

    async "actions.requested"(event) {
      for (const action of event.data.actions) {
        if (action.kind === "tool-call") {
          pendingInputs.set(action.callId, action.input);
        }
      }
    },

    async "action.result"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      // Only authored tool calls carry a tool name; framework controls do not.
      const result = event.data.result;
      const toolName = "toolName" in result ? result.toolName : null;
      if (typeof toolName !== "string") return;
      const callId = "callId" in result ? result.callId : null;
      const args = callId ? pendingInputs.get(callId) : undefined;
      if (callId) pendingInputs.delete(callId);
      const output = "output" in result ? result.output : undefined;
      await guarded("action.result", () =>
        recordToolCall({
          workspaceId,
          runId,
          toolName,
          ok: event.data.status === "completed",
          // A HITL "rejected" is a policy denial, not a runtime failure: it
          // never executed. Distinguish it from a real error code.
          errorCode: event.data.error?.code ?? (event.data.status === "rejected" ? "hitl_denied" : undefined),
          args,
          result: output,
        }),
      );
    },

    async "input.requested"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      for (const request of event.data.requests) {
        // Only a question is a durable agent question; approvals and session
        // limits ride the reviews/approvals surface instead.
        if (request.kind !== "question") continue;
        await guarded("input.requested", () =>
          recordQuestion({
            runId,
            workspaceId,
            question: request.prompt,
            options: request.options ?? [],
          }),
        );
      }
    },

    async "message.received"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("message.received", () =>
        mirrorMessage({
          runId,
          workspaceId,
          role: "user",
          content: event.data.message,
          parts: event.data.parts ?? null,
        }),
      );
    },

    async "message.completed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("message.completed", () =>
        mirrorMessage({
          runId,
          workspaceId,
          role: "assistant",
          content: event.data.message,
        }),
      );
    },

    async "session.completed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("session.completed", () =>
        closeRun({ runId, workspaceId, state: "succeeded" }),
      );
      void event;
    },

    async "session.failed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      await guarded("session.failed", () =>
        closeRun({
          runId,
          workspaceId,
          state: "failed",
          error: failureDetail(event),
        }),
      );
    },

    async "turn.completed"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      // A completed turn does NOT close the run: a session waits for its next
      // message rather than ending, so session.completed never fires for an
      // open session. The turn boundary is what the timeline shows, and the
      // run's waiting state stays honest until cancel or session end.
      await guarded("turn.completed", () =>
        recordRoundEvent({
          runId,
          workspaceId,
          type: "turn.completed",
          data: { turnId: event.data.turnId },
        }),
      );
    },

    async "turn.cancelled"(event, ctx) {
      const workspaceId = workspaceIdOf(ctx);
      const runId = await runIdOf(ctx);
      if (!workspaceId || !runId) return;
      // A cancelled turn is NOT a terminal run: the session continues and takes
      // the next message (eve protocol docs), so only session.completed /
      // session.failed close the run. Record the cancellation on the timeline.
      await guarded("turn.cancelled", () =>
        recordRoundEvent({
          runId,
          workspaceId,
          type: "turn.cancelled",
          data: { turnId: event.data.turnId },
        }),
      );
    },
  },
});
