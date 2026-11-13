import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef, projectSubjectOf } from "../../../../src/domains/agents/queries";
import {
  AGENT_SEARCH_MAX_RESULTS,
  DOCUMENTS_SEARCH_CAPABILITY,
  searchDocumentsForAgent,
} from "../../../../src/domains/knowledge/agent-search";
import { runSessionRef } from "../lib/run-session";

/*
 * A read capability over the workspace's extracted documents. It returns
 * passages with their document id, title and span and writes nothing. Changing
 * a document is not something this tool can do: any write becomes an action
 * proposal in the existing review queue. The workspace and user come from the
 * session's verified auth, never from the model's arguments.
 */
export default defineTool({
  description:
    "Search the extracted text of the owner's library documents (notes and captured sources are NOT covered). Use it only when the answer depends on the owner's own material, never for general knowledge. Returns up to 5 relevant passages with document title and id; cite them as [[n]] in result order. Empty results mean no indexed extraction matched: a retrieval miss, not proof the library holds nothing. `degraded` or a partial/unknown `coverage` means the search could not see everything; say so. Read-only.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(AGENT_SEARCH_MAX_RESULTS).optional(),
    projectId: z
      .string()
      .uuid()
      .optional()
      .describe("Limit the search to one project. Ignored when the run is already bound to a project."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }

    const run = await getRunBySessionRef(runSessionRef(ctx.session), workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, DOCUMENTS_SEARCH_CAPABILITY)) {
      return { ok: false as const, error: "documents.search is not in this run's policy snapshot" };
    }

    // A run started from a project stays inside it, whatever the model asks for.
    const bound = projectSubjectOf(run.subjects);

    // Search needs only the workspace; the role is the lowest that can read.
    return searchDocumentsForAgent(
      { userId: current.principalId, workspaceId, role: "viewer" },
      { query: input.query, limit: input.limit, projectId: bound?.id ?? input.projectId },
    );
  },
});
