import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { proposeArtifactRevision, ArtifactReviseNotAllowedError } from "../../../../src/domains/knowledge/revision-proposals";

/*
 * Proposes a revision to a saved artifact. The artifact's current words are
 * never overwritten: the proposal waits in the owner's review queue, and
 * approval appends the proposed content as a new version. If the artifact
 * changed since the proposal was made, approval refuses and the run should
 * re-read the current version and propose again. The run's frozen policy
 * must allow artifacts.revise.
 */
export default defineTool({
  description:
    "Propose new content for an existing artifact (a note, report, deck or infographic). Nothing changes until the owner approves it in the review queue; approval appends your content as a new version and keeps the old one. Read the artifact's current content first and revise against it. Pass a stable dedupe id so a retry proposes once.",
  inputSchema: z.object({
    artifactId: z.string().uuid(),
    content: z.record(z.string(), z.unknown()).describe("The full proposed content as a JSON object - Tiptap/ProseMirror doc for rich text, or the artifact's structured payload."),
    plainText: z.string().max(100_000).optional().describe("Plain-text projection of the content, for search."),
    note: z.string().max(500).optional().describe("What this revision changes and why, for the review card."),
    dedupeId: z.string().min(1).max(200).describe("Stable identifier for this revision intent, so a retry proposes once."),
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
    if (!toolAllowed(run.policySnapshot, "artifacts.revise")) {
      return { ok: false as const, error: "artifacts.revise is not in this run's policy snapshot" };
    }
    try {
      const result = await proposeArtifactRevision(
        { userId: current.principalId, workspaceId },
        {
          artifactId: input.artifactId,
          content: input.content,
          plainText: input.plainText,
          note: input.note,
          dedupeKey: `${run.id}:${input.dedupeId}`,
          runId: run.id,
        },
      );
      return { ok: true as const, proposalId: result.proposalId, deduplicated: result.deduplicated, status: "awaiting review" };
    } catch (cause) {
      if (cause instanceof ArtifactReviseNotAllowedError) return { ok: false as const, error: cause.message };
      return { ok: false as const, error: "revision proposal failed" };
    }
  },
});
