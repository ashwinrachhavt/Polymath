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

/*
 * A read capability over the workspace's extracted documents. It returns
 * passages with their document id, title and span and writes nothing. Changing
 * a document is not something this tool can do: any write becomes an action
 * proposal in the existing review queue. The workspace and user come from the
 * session's verified auth, never from the model's arguments.
 */
export default defineTool({
  description:
    "Search the extracted text of the owner's library documents (notes and captured sources are NOT covered today). This is the FIRST call for anything in their documents — what they wrote, decided, or saved about a topic. Semantic + keyword hybrid when an embedding provider is configured, keyword full-text otherwise (the result's mode field says which, a degraded field names a failed leg — when it is present, say the search ran partial; a coverage field marks a partially indexed document, whose tail search cannot see). Returns the best matching passages with document id, title, character span, and passage lineage (extractionId, chunkIndex), so answers can cite them with [[n]] markers matching the result order. The owner's own words are stronger evidence than a web result: if the library can answer, do not search the web. Empty results mean no indexed extraction matched — that can be a retrieval miss, a document not yet indexed, or a degraded leg as much as genuine absence; say which you know and never claim the library holds nothing relevant unless the result is not degraded and indexing is known complete. Read-only; the run's frozen policy must allow documents.search.",
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

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
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
