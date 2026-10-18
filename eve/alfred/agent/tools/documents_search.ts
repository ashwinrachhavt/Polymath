import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
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
    "Search the workspace's documents by meaning. Returns the best matching passages with document id, title and character span, so answers can cite them. Read-only; the run's frozen policy must allow documents.search.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(AGENT_SEARCH_MAX_RESULTS).optional(),
    dossierId: z.string().uuid().optional().describe("Limit the search to one dossier. Ignored when the run is already bound to a dossier."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Axiom run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, DOCUMENTS_SEARCH_CAPABILITY)) {
      return { ok: false as const, error: "documents.search is not in this run's policy snapshot" };
    }

    // A run started from a dossier stays inside it, whatever the model asks for.
    const bound = Array.isArray(run.subjects)
      ? (run.subjects as Array<{ type?: string; id?: string }>).find((x) => x?.type === "dossier" && typeof x.id === "string")
      : undefined;

    // Search needs only the workspace; the role is the lowest that can read.
    return searchDocumentsForAgent(
      { userId: current.principalId, workspaceId, role: "viewer" },
      { query: input.query, limit: input.limit, dossierId: bound?.id ?? input.dossierId },
    );
  },
});
