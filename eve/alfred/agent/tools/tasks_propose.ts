import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { proposeTask } from "../../../../src/domains/work/proposals";

/*
 * Turns a run finding into a reviewable task proposal. The agent tool
 * surface is read-only on purpose: the follow-up the model saw lands in the
 * owner's review queue, and only the owner's approval creates the task. A
 * resumed step or a retry re-derives the same dedupe key and resolves the
 * existing proposal instead of queuing a second one. The run's frozen
 * policy must allow tasks.create.
 */
export default defineTool({
  description:
    "Propose a follow-up task for the owner to review. Call when the run finds work someone should do later - a follow-up from a document, an open question, a next step. Do not propose work the open-task list already covers (check tasks_read first). Nothing is created until the owner approves it in the review queue; the approval creates the task with links back to the source material. Pass stable source identifiers so a retry resolves the same proposal.",
  inputSchema: z.object({
    title: z.string().min(1).max(500).describe("The task as the owner should see it, imperative mood."),
    description: z.string().max(4000).optional().describe("Why this follow-up matters, with the finding that prompted it."),
    dueAt: z.string().datetime().optional().describe("ISO timestamp when the follow-up is due, if the source names one."),
    estimateMinutes: z.number().int().min(1).max(480).optional(),
    links: z
      .array(
        z.object({
          targetType: z
            .enum(["task", "project", "space", "note", "artifact", "document", "source", "event", "contact", "company", "person", "organization", "opportunity", "run", "thread", "zettel"])
            .describe("Link target kind, usually document for source material."),
          targetId: z.string().uuid(),
          label: z.string().max(200).optional(),
        }),
      )
      .max(10)
      .optional()
      .describe("Source material the task points back to, e.g. the document it came from."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this follow-up (e.g. the source passage id), so a retry proposes once."),
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
    if (!toolAllowed(run.policySnapshot, "tasks.create")) {
      return { ok: false as const, error: "tasks.create is not in this run's policy snapshot" };
    }
    const result = await proposeTask(
      { userId: current.principalId, workspaceId },
      {
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        estimateMinutes: input.estimateMinutes,
        links: input.links,
        dedupeKey: `${run.id}:${input.dedupeId}`,
        runId: run.id,
      },
    );
    return { ok: true as const, proposalId: result.proposalId, deduplicated: result.deduplicated, status: "awaiting review" };
  },
});
