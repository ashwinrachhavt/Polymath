import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { proposeConflictMove } from "../../../../src/domains/calendar/conflict-proposals";

/*
 * ASH-282: turn one option from calendar_conflicts into a move proposal. The
 * tool never touches the calendar. The proposal waits for the owner; only
 * their approval moves the event, and only a Polymath-owned event at the
 * version and in a slot that are still valid when this is called.
 */
export default defineTool({
  description:
    "Propose moving an event to a time offered by calendar_conflicts, for the owner to approve. Pass eventId, expectedVersion, startsAt and endsAt exactly as a 'move' option returned them. Nothing changes until the owner approves in the review queue. A refusal (event changed, time taken, event owned by Google) is final for that option: read the conflicts again rather than retrying with a different time. Propose one option per conflict; say what you proposed and that it awaits approval.",
  inputSchema: z.object({
    eventId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, "calendar.propose")) {
      return { ok: false as const, error: "calendar.propose is not in this run's policy snapshot" };
    }
    const result = await proposeConflictMove(
      { workspaceId, userId: current.principalId },
      {
        eventId: input.eventId,
        expectedVersion: input.expectedVersion,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        runId: run.id,
      },
    );
    if (!result.ok) return { ok: false as const, code: result.code, error: result.message };
    return { ok: true as const, proposalId: result.proposalId, deduplicated: result.deduplicated, status: "awaiting owner approval" };
  },
});
