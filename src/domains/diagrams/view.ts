import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifactVersions, artifacts, canvases } from "@/domains/knowledge/schema";
import { DIAGRAM_TYPES, type DiagramType } from "./types";

/*
 * Read model behind the DiagramView at /artifacts/[artifactId] (spec
 * art_Yi8Fwsqn §6). A diagram artifact stores Mermaid — never a rendered
 * scene — so the view re-renders client-side from the version chain, and the
 * version switcher walks artifact_versions directly.
 *
 * Everything here is server-safe: no mermaid import, no client boundary.
 */

/** The envelope the eve diagram tool persists into artifact_versions.content. */
export type DiagramVersionContent = { type: "diagram"; mermaid: string; diagramType: DiagramType };

/**
 * Parse one stored version's content envelope. Null for anything else — the
 * view renders an honest "unreadable version" state, never a guess. This is
 * the dispatch-side twin of parseStructuredContent for deck/infographic.
 */
export function parseDiagramVersionContent(content: unknown): DiagramVersionContent | null {
  if (typeof content !== "object" || content === null) return null;
  const candidate = content as { type?: unknown; mermaid?: unknown; diagramType?: unknown };
  if (candidate.type !== "diagram") return null;
  if (typeof candidate.mermaid !== "string" || candidate.mermaid.length === 0) return null;
  if (
    typeof candidate.diagramType !== "string" ||
    !(DIAGRAM_TYPES as readonly string[]).includes(candidate.diagramType)
  ) {
    return null;
  }
  return { type: "diagram", mermaid: candidate.mermaid, diagramType: candidate.diagramType as DiagramType };
}

/**
 * Which version the switcher shows. A request for a version that is not in
 * the chain (a stale switcher after a concurrent refine) falls forward to the
 * newest version — never to nothing, never to an unrendered blank.
 */
export function pickDiagramVersion<T extends { versionNumber: number }>(
  versions: T[],
  requested?: number,
): T | undefined {
  if (versions.length === 0) return undefined;
  const newest = versions.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
  if (requested === undefined) return newest;
  return versions.find((version) => version.versionNumber === requested) ?? newest;
}

/** One walkable version, shaped for the client boundary (dates as ISO text). */
export type DiagramVersionView = {
  versionNumber: number;
  mermaid: string;
  diagramType: DiagramType;
  createdAt: string;
  /** How this version arrived — "generated" from a run, "edited" from a hand save. */
  reason: string;
};

export type DiagramArtifactView = {
  title: string;
  /** The linked canvas row, when one exists — the canvas route target. */
  canvasId: string | null;
  /** Ascending by versionNumber. */
  versions: DiagramVersionView[];
};

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
