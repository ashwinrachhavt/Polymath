import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifactVersions, artifacts, canvases } from "@/domains/knowledge/schema";
import type { DiagramType } from "./types";
import { parseDiagramVersionContent, type DiagramArtifactView } from "./view";

/*
 * Server read model behind the DiagramView at /artifacts/[artifactId] (spec
 * art_Yi8Fwsqn §6). Server-only — drizzle and pg must never reach the client
 * bundle, so the client component imports the pure logic from ./view and the
 * page imports the queries from here.
 */

export async function getDiagramArtifactView(auth: AuthContext, artifactId: string): Promise<DiagramArtifactView | null> {
  const [artifact] = await db
    .select({ title: artifacts.title })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "diagram")))
    .limit(1);
  if (!artifact) return null;

  // Workspace is part of both lookups: a cross-workspace artifactId or a
  // tampered canvas row resolves to the same null as a bogus id.
  const [canvas] = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.artifactId, artifactId), eq(canvases.workspaceId, auth.workspaceId)))
    .limit(1);

  const rows = await db
    .select({
      versionNumber: artifactVersions.versionNumber,
      content: artifactVersions.content,
      plainText: artifactVersions.plainText,
      reason: artifactVersions.reason,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.workspaceId, auth.workspaceId)))
    .orderBy(asc(artifactVersions.versionNumber));

  const versions = rows.flatMap((row) => {
    const parsed = parseDiagramVersionContent(row.content);
    if (parsed) {
      return [
        {
          versionNumber: row.versionNumber,
          mermaid: parsed.mermaid,
          diagramType: parsed.diagramType,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
        },
      ];
    }
    // A malformed envelope still shows its plain-text source honestly rather
    // than vanishing from the chain — the view renders it as a failed version.
    return row.plainText
      ? [
          {
            versionNumber: row.versionNumber,
            mermaid: row.plainText,
            diagramType: "flowchart" as DiagramType,
            reason: row.reason,
            createdAt: row.createdAt.toISOString(),
          },
        ]
      : [];
  });

  return { title: artifact.title, canvasId: canvas?.id ?? null, versions };
}
