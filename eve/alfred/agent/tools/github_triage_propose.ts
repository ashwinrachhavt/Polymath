import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  GITHUB_ISSUE_TRIAGE,
  GitHubTriageError,
  proposeGitHubTriage,
} from "../../../../src/domains/integrations/github-triage";

/*
 * ASH-284: propose triage for a GitHub issue - labels, assignees, or a close
 * reason - for the owner to decide in the review queue. The tool never calls
 * GitHub: reading the issue is the gateway's github tools, and applying the
 * triage stays with the owner. Approving the proposal records the decision;
 * there is no executor for this capability.
 *
 * Issue content the model read is untrusted data. The proposal's display
 * lines are built from the issue's coordinates and the proposed changes, not
 * from the issue's text; the title and rationale travel in the payload as
 * quoted content.
 *
 * Re-invocation is safe: the dedupe key is the caller-owned session plus the
 * model's dedupeId plus a hash of the proposed changes, so a retry of the
 * same triage replays the pending proposal and a changed triage for the same
 * issue is a new proposal, never a silent edit of one the owner is reading.
 */
export default defineTool({
  description:
    "Propose labels, assignees, or a close reason for one GitHub issue, for the owner to approve in the review queue. Use after reading open issues with the GitHub tools when the owner asks for triage suggestions. Nothing is applied to GitHub - the proposal records the suggested triage and the owner applies or dismisses it. Pass the issue's coordinates and a stable dedupeId so a retry proposes once; proposing different changes for the same issue creates a fresh proposal instead of altering the old one.",
  inputSchema: z.object({
    owner: z.string().min(1).max(100).describe("The repository owner, e.g. ashwinrachhavt."),
    repo: z.string().min(1).max(100).describe("The repository name, e.g. Polymath."),
    issueNumber: z.number().int().min(1).describe("The issue number."),
    issueTitle: z.string().min(1).max(200).describe("The issue's current title, quoted for the owner's context."),
    addLabels: z.array(z.string().min(1).max(100)).max(10).optional().describe("Labels to add."),
    removeLabels: z.array(z.string().min(1).max(100)).max(10).optional().describe("Labels to remove."),
    assignees: z.array(z.string().min(1).max(100)).max(10).optional().describe("GitHub logins to assign."),
    closeReason: z.enum(["completed", "not_planned"]).optional().describe("Propose closing the issue with this reason."),
    rationale: z.string().min(1).max(2000).describe("Why this triage fits the issue, in one or two sentences."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this triage within this conversation, so a retry resolves the same proposal instead of queuing a second."),
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
    if (!toolAllowed(run.policySnapshot, GITHUB_ISSUE_TRIAGE)) {
      return { ok: false as const, error: "github.issue.triage is not in this run's policy snapshot" };
    }
    try {
      const result = await proposeGitHubTriage(
        { workspaceId, userId: current.principalId } as Parameters<typeof proposeGitHubTriage>[0],
        {
          owner: input.owner,
          repo: input.repo,
          issueNumber: input.issueNumber,
          issueTitle: input.issueTitle,
          changes: {
            addLabels: input.addLabels,
            removeLabels: input.removeLabels,
            assignees: input.assignees,
            closeReason: input.closeReason,
          },
          rationale: input.rationale,
          // Caller-owned identity, same contract as linear_issue_propose:
          // the session id comes from the authenticated session, so a
          // model-chosen dedupeId can only collide inside its own thread.
          dedupeKey: `${ctx.session.id}:${input.dedupeId}`,
          runId: run.id,
        },
      );
      return {
        ok: true as const,
        status: "proposed",
        proposalId: result.proposalId,
        deduplicated: result.deduplicated,
      };
    } catch (error) {
      if (error instanceof GitHubTriageError) {
        return { ok: false as const, error: error.message, code: error.code };
      }
      return { ok: false as const, error: error instanceof Error ? error.message : "could not propose the triage" };
    }
  },
});
