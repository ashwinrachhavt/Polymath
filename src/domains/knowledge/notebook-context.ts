import type { AuthContext } from "@/domains/identity/resolve";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { artifactLinks, artifacts } from "@/domains/knowledge/schema";
import { getProjectDetail, projectDocumentIds } from "@/domains/knowledge/projects";
import { sourceReadiness, type SourceReadiness } from "@/domains/knowledge/source-readiness";

/*
 * What an agent needs to open a notebook (NotebookLM parity, S6).
 *
 * A "notebook" is a project: the bounded source set. This module
 * resolves one and returns what an agent can act on: the sources, their
 * readiness, and the generated artifacts the notebook already owns. It reads
 * only; generating is Studio's job and drafting is the owner's.
 *
 * Readiness matters to the answer: an agent that cites a source still being
 * embedded is citing something search cannot see, so the contract names it.
 */

export const NOTEBOOK_OPEN_CAPABILITY = "notebook.open";

export type NotebookSummary = {
  projectId: string;
  title: string;
  sources: Array<{ documentId: string; title: string; readiness: SourceReadiness; kind: "document" | "video" }>;
  /** Generated reports, decks and infographics bound to this notebook. */
  artifacts: Array<{ artifactId: string; title: string; kind: string; status: string }>;
};

export async function openNotebook(auth: AuthContext, input: { projectId: string }): Promise<NotebookSummary | null> {
  const detail = await getProjectDetail(auth, input.projectId);
  if (!detail) return null;

  const documentIds = await projectDocumentIds(auth, input.projectId);
  const readiness = documentIds && documentIds.length > 0
    ? await Promise.all(documentIds.map((id) => sourceReadiness(auth, id)))
    : [];

  // Artifacts that link to one of this project's documents, newest first. This
  // is the same link the Studio save writes, so it cannot drift from what the
  // notebook generated. Two bounded queries, never one per document.
  const linked = documentIds && documentIds.length > 0
    ? await (async () => {
        const links = await db
          .selectDistinct({ artifactId: artifactLinks.artifactId })
          .from(artifactLinks)
          .where(and(
            eq(artifactLinks.workspaceId, auth.workspaceId),
            eq(artifactLinks.targetType, "document"),
            inArray(artifactLinks.targetId, documentIds),
          ));
        if (links.length === 0) return [];
        return db
          .select({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind, status: artifacts.status })
          .from(artifacts)
          .where(and(
            eq(artifacts.workspaceId, auth.workspaceId),
            inArray(artifacts.id, links.map((l) => l.artifactId)),
            isNull(artifacts.archivedAt),
          ))
          .orderBy(desc(artifacts.createdAt))
          .limit(30);
      })()
    : [];

  return {
    projectId: detail.id,
    title: detail.title,
    sources: readiness
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => ({ documentId: row.documentId, title: row.title, readiness: row.readiness, kind: row.kind })),
    artifacts: linked.map((row) => ({ artifactId: row.id, title: row.title, kind: row.kind, status: row.status })),
  };
}
