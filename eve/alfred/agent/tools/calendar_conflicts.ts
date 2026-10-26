import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { listCalendarConflicts } from "../../../../src/domains/calendar/conflict-proposals";

/*
 * ASH-282: read the owner's calendar for overlapping events and return ranked
 * ways to resolve each one, with the trade-off of every option. Read only. The
 * calendar is the store the Google sync fills, so the result says when Google
 * was last read and what was not checked.
 */
export default defineTool({
  description:
    "Find overlapping events on the owner's calendar in the next days and get ranked rescheduling options for each, with the trade-offs of every option (how far it moves, who it affects, whether it clears the overlap). Use when the owner asks about double-booking, a clash, or 'what's wrong with my week'. Read only: it changes nothing. Events from Google Calendar cannot be moved from here, so they come back as 'resolve_in_provider' advice. To act on a move option, pass it unchanged to calendar_conflict_propose; never invent a time. Report the notices as they are: they say what was not checked.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(30).optional().describe("How many days ahead to check. Defaults to 14."),
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
    if (!toolAllowed(run.policySnapshot, "calendar.read")) {
      return { ok: false as const, error: "calendar.read is not in this run's policy snapshot" };
    }
    const report = await listCalendarConflicts({ workspaceId, userId: current.principalId }, { days: input.days });
    return { ok: true as const, ...report };
  },
});
