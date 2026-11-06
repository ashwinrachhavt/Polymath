import { and, asc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { canvases, canvasVersions } from "@/domains/knowledge/schema";

/*
 * Server read model behind the canonical canvas route
 * /polymath/canvas/[canvasId] — the bridge between the diagram tool's
 * Postgres-persisted scenes (canvases + canvas_versions) and the Excalidraw
 * editor, which the /apps/polymath/canvas preview screen never loads (it
 * reads browser-local preview storage instead).
 *
 * Server-only: drizzle must never reach the client bundle. The scene payloads
 * pass through raw; parsing stays in the pure, client-safe
 * parseCanvasScene (./types), so the editor renders an honest unreadable
 * state for a malformed version rather than the server dropping it silently.
 */

export type CanvasSceneVersionView = {
  versionNumber: number;
  /** Raw canvas_versions.scene — parse with parseCanvasScene client-side. */
  scene: unknown;
  createdAt: string;
};

export type CanvasSceneView = {
  title: string;
  /** The diagram artifact this canvas backs, for the back link. */
  artifactId: string;
  /** Ascending by versionNumber; the newest is the working drawing. */
  versions: CanvasSceneVersionView[];
};

export async function getCanvasSceneView(auth: AuthContext, canvasId: string): Promise<CanvasSceneView | null> {
  // Workspace is part of every lookup: a cross-workspace canvasId resolves
  // to the same null as a bogus one — no existence leak across tenants.
  const [canvas] = await db
    .select({ id: canvases.id, title: canvases.title, artifactId: canvases.artifactId })
    .from(canvases)
    .where(and(eq(canvases.id, canvasId), eq(canvases.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!canvas) return null;

  const rows = await db
    .select({
      versionNumber: canvasVersions.versionNumber,
      scene: canvasVersions.scene,
      createdAt: canvasVersions.createdAt,
    })
    .from(canvasVersions)
    .where(and(eq(canvasVersions.canvasId, canvas.id), eq(canvasVersions.workspaceId, auth.workspaceId)))
    .orderBy(asc(canvasVersions.versionNumber));

  return {
    title: canvas.title,
    artifactId: canvas.artifactId,
    versions: rows.map((row) => ({
      versionNumber: row.versionNumber,
      scene: row.scene,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
