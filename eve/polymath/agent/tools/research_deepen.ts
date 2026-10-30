import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  DEEP_DIVE_MAX_HOPS,
  expandResearchHop,
  type ResearchNode,
} from "../../../../src/domains/knowledge/research-expansion";

/*
 * ASH-293: "go deeper on X" expands the research graph one hop at a time. The
 * tool takes the nodes the conversation has already reached, so the run — not
 * this module — holds the dive's state, and every call returns the remaining
 * budget for the model to report.
 *
 * One hop per call, deliberately. A tool that kept expanding until some
 * internal limit would make the cost invisible, and the ticket's whole point is
 * that the budget stays on screen while the dive is open.
 */
export default defineTool({
  description:
    "Go one hop deeper in a research graph. Use when the owner says to go deeper on something, or asks what relates to a node. Each call expands one node: it follows connections already in the library first (free), and only searches the web when the library has nothing new. Returns the nodes it reached, any web pages worth reading, and the remaining budget — report the remaining hops to the owner when you stop. Do not call this repeatedly without telling the owner how much budget is left.",
  inputSchema: z.object({
    fromArtifactId: z
      .string()
      .uuid()
      .optional()
      .describe("The node to expand, from a previous hop's result. Omit to start a dive from a question."),
    query: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("A question to start a dive from, when there is no node yet. The best-matching library document becomes the seed."),
    hopsUsed: z.number().int().min(0).max(DEEP_DIVE_MAX_HOPS).describe("How many hops this dive has already taken. Start at 0."),
    callsUsed: z.number().int().min(0).describe("How many paid searches this dive has already made, summed from prior results. Start at 0."),
    callsMax: z.number().int().min(0).optional().describe("The owner's cap on paid searches for this dive, when one was stated."),
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
    if (!toolAllowed(run.policySnapshot, "documents.search")) {
      return { ok: false as const, error: "documents.search is not in this run's policy snapshot" };
    }

    const result = await expandResearchHop(
      { workspaceId, userId: current.principalId } as Parameters<typeof expandResearchHop>[0],
      {
        ...(input.fromArtifactId ? { fromArtifactId: input.fromArtifactId } : {}),
        ...(input.query ? { query: input.query } : {}),
        hopsUsed: input.hopsUsed,
        callsUsed: input.callsUsed,
        ...(input.callsMax !== undefined ? { callsMax: input.callsMax } : {}),
      },
    );

    if (!result.ok) return { ok: false as const, error: result.error };

    // The nodes carry the shape the thread renders as record cards, so a hop
    // shows up as the documents it reached rather than as a paragraph about them.
    const asRecords = (nodes: ResearchNode[]) =>
      nodes.map((node) => ({ kind: "document" as const, id: node.artifactId, title: node.title, subtitle: node.via ?? undefined }));

    return {
      ok: true as const,
      seed: result.seed,
      added: asRecords(result.added),
      candidates: result.candidates,
      budget: result.budget,
      ...(result.stoppedBecause ? { stoppedBecause: result.stoppedBecause } : {}),
    };
  },
});
