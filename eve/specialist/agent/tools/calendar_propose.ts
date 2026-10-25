import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
import { proposeCalendarChange } from "../../../../src/domains/calendar/proposals";
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";

/*
 * Calendar writes are proposals. This tool writes an action_proposals row with
 * the exact change; it never touches the calendar. The owner approves with one
 * tap on the week view and the approved revision executes there. The run's
 * frozen policy must allow calendar.propose.
 */
export default defineTool({
  description:
    "Propose a calendar change for the owner to approve: time-block a task, add an event, move an event, or cancel an event. Use when the brief asks for scheduling work or when the run's findings imply a time commitment the owner should see. It will not change the calendar itself — even after approval the write goes through the owner's calendar, and a refusal from it is reported, not retried. Pass the event's source in the proposal so the owner can judge it.",
  inputSchema: z.object({
    change: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("block"), taskId: z.string().uuid(), minutes: z.number().int().min(5).max(480).optional() }),
      z.object({ kind: z.literal("create"), title: z.string().min(1).max(200), startsAt: z.string().datetime(), endsAt: z.string().datetime() }),
      z.object({ kind: z.literal("move"), eventId: z.string().uuid(), expectedVersion: z.number().int().min(1), startsAt: z.string().datetime(), endsAt: z.string().datetime(), title: z.string().max(200).optional() }),
      z.object({ kind: z.literal("cancel"), eventId: z.string().uuid(), expectedVersion: z.number().int().min(1), title: z.string().max(200).optional() }),
    ]),
    intentKey: z.string().min(1).max(120).describe("Stable key for this intent so a retry does not create a second proposal"),
  }),
  async execute(input, ctx) {
    const workspaceId = ctx.session.auth.current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string") return { ok: false as const, error: "no workspace in session" };
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") return { ok: false as const, error: "no active Polymath run bound to this session" };
    if (!toolAllowed(run.policySnapshot, "calendar.propose")) {
      return { ok: false as const, error: "calendar.propose is not in this run's policy snapshot" };
    }
    const { proposalId, deduplicated } = await proposeCalendarChange(
      { workspaceId },
      { change: input.change, dedupeKey: `${run.id}:${input.intentKey}`, runId: run.id },
    );
    return { ok: true as const, proposalId, deduplicated, status: "awaiting owner approval" };
  },
});
