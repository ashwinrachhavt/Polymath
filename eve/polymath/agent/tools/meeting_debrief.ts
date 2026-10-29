import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { debriefPastedTranscript } from "../../../../src/domains/knowledge/meeting-debrief";

/*
 * ASH-279: read a meeting transcript and propose the tasks in it, with owners
 * and due dates. Nothing is created here — every item lands in the review
 * queue as a task proposal and only the owner's approval makes it real.
 *
 * The transcript is untrusted content. It is passed as data and the debrief
 * prompt says so; a line in it that tells the model to do something is
 * something a person said in a meeting, not an instruction to this run.
 */
export default defineTool({
  description:
    "Read a meeting transcript and propose the tasks it assigned, for the owner to approve. Use when the owner pastes a transcript or notes from a meeting and asks what came out of it, or when a saved meeting transcript should become follow-up work. Each proposed task carries the owner named in the meeting when it says who, a due date when one was stated, and the sentence it came from. Nothing is created until the owner approves in the review queue. Return nulls rather than padding when a meeting had no real follow-through.",
  inputSchema: z.object({
    transcript: z
      .string()
      .min(1)
      .max(40_000)
      .describe("The meeting transcript or notes, verbatim. Pass what the owner gave you; do not summarise it first, because the summary loses who committed to what."),
    title: z.string().max(200).optional().describe("What this meeting was, for the review card, e.g. 'Weekly product sync'. Defaults to Pasted transcript."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this transcript, so debriefing it twice resolves the same proposals instead of doubling them."),
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
    if (!toolAllowed(run.policySnapshot, "meetings.debrief")) {
      return { ok: false as const, error: "meetings.debrief is not in this run's policy snapshot" };
    }
    // Proposals only exist if the run may also create the task they become;
    // refusing up front beats producing a queue of unapprovable items.
    if (!toolAllowed(run.policySnapshot, "tasks.create")) {
      return { ok: false as const, error: "tasks.create is not in this run's policy snapshot, so the proposed tasks could not be approved" };
    }
    try {
      const result = await debriefPastedTranscript(
        { workspaceId } as Parameters<typeof debriefPastedTranscript>[0],
        {
          transcript: input.transcript,
          ...(input.title ? { title: input.title } : {}),
          batchKey: `${run.id}:${input.dedupeId}`,
        },
      );
      const count = result.taskProposalIds.length + result.noteProposalIds.length + result.followUpProposalIds.length;
      return {
        ok: true as const,
        status: "awaiting review",
        proposed: count,
        taskProposalIds: result.taskProposalIds,
        noteProposalIds: result.noteProposalIds,
        followUpProposalIds: result.followUpProposalIds,
        deduplicated: result.deduplicated,
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "could not read the transcript" };
    }
  },
});
