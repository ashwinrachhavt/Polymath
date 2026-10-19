import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { ingestDocument, WikiError } from "../../../../src/domains/knowledge/wiki";
import { WIKI_INGEST_CAPABILITY } from "../../../../src/domains/knowledge/wiki-agent";

/*
 * Ingests one document into the wiki: writes or updates its article, rebuilds
 * the topic hubs and the index, appends the log. Every write is a new
 * append-only artifact version inside the session's own workspace; source
 * documents are never modified. The run's frozen policy must allow
 * wiki.ingest.
 */
export default defineTool({
  description:
    "Ingest a document into the wiki: write or update its article, refresh its topic hubs and the master index, and log the ingest. Call after documents_search identifies what is new or changed. Writes wiki pages only, never the source documents; the run's frozen policy must allow wiki.ingest.",
  inputSchema: z.object({
    documentId: z.string().uuid(),
    topics: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/))
      .max(5)
      .optional()
      .describe("Topic slugs to file the article under. Omit to let the summarizer name them."),
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
    if (!toolAllowed(run.policySnapshot, WIKI_INGEST_CAPABILITY)) {
      return { ok: false as const, error: "wiki.ingest is not in this run's policy snapshot" };
    }
    try {
      const result = await ingestDocument(
        { userId: current.principalId, workspaceId, role: "member" },
        { documentId: input.documentId, topics: input.topics },
      );
      return { ok: true as const, ...result };
    } catch (cause) {
      if (cause instanceof WikiError) return { ok: false as const, error: cause.message };
      return { ok: false as const, error: "ingest failed" };
    }
  },
});
