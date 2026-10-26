import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  draftLinearIssueFromText,
  LinearIssueNoteError,
} from "../../../../src/domains/capture/linear-issue-proposal";

/*
 * ASH-285: draft a Linear-issue proposal from material the owner pastes in
 * the conversation. The tool never calls Linear — the draft lands as a
 * proposal note with a provenance marker, and turning it into a real issue
 * stays with the owner.
 *
 * The pasted material is untrusted content. It is passed as data and the
 * drafting prompt says so; a line in it that tells the model to do something
 * is part of the source being summarised, not an instruction to this run.
 *
 * Re-invocation is safe: the source's stable key plus its content hash make
 * an unchanged source replay the existing draft, a changed source refresh
 * it, and an owner-edited or unsaved draft refuse rather than be replaced.
 */
export default defineTool({
  description:
    "Draft a Linear issue proposal from text the owner provides, saved as a proposal note they review before anything becomes an issue. Use when the owner pastes a bug report, feature idea, or follow-up and asks for a Linear issue from it. Nothing is sent to Linear: the draft waits in the library with its acceptance criteria, and repeat calls with the same material return the same draft instead of duplicating it. If the owner has edited the draft and the source changed, the draft is kept and the refusal says why. Pass a stable dedupeId for the source material so a retry drafts once.",
  inputSchema: z.object({
    title: z.string().min(1).max(200).describe("What the source material is, e.g. 'Pasted bug report about the inbox badge'. Not the issue title - the proposal names itself."),
    text: z
      .string()
      .min(1)
      .max(40_000)
      .describe("The source material, verbatim. Pass what the owner gave you; do not summarise it first, because the summary loses the details the acceptance criteria need."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this source material, so drafting from it twice resolves the same proposal note instead of doubling it."),
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
    if (!toolAllowed(run.policySnapshot, "linear.issue.propose")) {
      return { ok: false as const, error: "linear.issue.propose is not in this run's policy snapshot" };
    }
    try {
      const result = await draftLinearIssueFromText(
        { workspaceId, userId: current.principalId } as Parameters<typeof draftLinearIssueFromText>[0],
        {
          title: input.title,
          text: input.text,
          sourceKey: `${run.id}:${input.dedupeId}`,
        },
      );
      return {
        ok: true as const,
        status: "drafted",
        artifactId: result.artifactId,
        title: result.title,
        generated: result.generated,
        outcome: result.outcome,
      };
    } catch (error) {
      if (error instanceof LinearIssueNoteError) {
        return { ok: false as const, error: error.message, code: error.code };
      }
      return { ok: false as const, error: error instanceof Error ? error.message : "could not draft the issue proposal" };
    }
  },
});
