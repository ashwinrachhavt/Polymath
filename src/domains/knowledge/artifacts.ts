import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { artifactLinks, artifactVersions, artifacts } from "./schema";

/**
 * The generated artifacts pinned to one notebook's documents, newest first
 * (spec W2: this read lived in the notebook page as two direct db queries —
 * a layering breach and a two-query serial stage). One query: the link set
 * rides as a subquery instead of a second round trip between queries.
 */
export async function listGeneratedArtifacts(workspaceId: string, documentIds: string[], limit = 20) {
  if (documentIds.length === 0) return [];
  return db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      status: artifacts.status,
      versionContent: artifactVersions.content,
    })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.workspaceId, workspaceId),
        inArray(
          artifacts.id,
          db
            .selectDistinct({ artifactId: artifactLinks.artifactId })
            .from(artifactLinks)
            .where(
              and(
                eq(artifactLinks.workspaceId, workspaceId),
                eq(artifactLinks.targetType, "document"),
                inArray(artifactLinks.targetId, documentIds),
              ),
            ),
        ),
        isNull(artifacts.archivedAt),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(limit);
}
