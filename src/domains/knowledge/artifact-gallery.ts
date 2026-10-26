import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { markdownToPlainText } from "@/lib/display-text";
import { briefFromContent } from "./design-brief-handoff";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifactLinks, artifactVersions, artifacts, documents } from "./schema";

/*
 * The artifact gallery: every artifact in the workspace, generated or
 * imported, with enough of its content to render a preview card. The detail
 * read returns the full current version plus its pinned sources.
 */

export type GalleryArtifact = {
  id: string;
  title: string;
  kind: string;
  status: string;
  /** How it arrived: a run produced it, or a document import created it. */
  origin: "run" | "upload" | "authored";
  createdAt: Date;
  updatedAt: Date;
  /** Plain-text projection, truncated for the card preview. */
  preview: string;
};

const PREVIEW_LENGTH = 280;

export async function listGalleryArtifacts(
  auth: AuthContext,
  input: {
    kind?: "note" | "zettel" | "document" | "memo" | "report" | "diagram" | "transcript" | "deck" | "infographic" | "other";
    origin?: "run" | "upload" | "authored";
    /** Title substring, case-insensitive; filtered in SQL. */
    query?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: GalleryArtifact[]; total: number }> {
  const filters = [eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)];
  if (input.kind) filters.push(eq(artifacts.kind, input.kind));
  if (input.origin === "run") filters.push(isNotNull(artifacts.producedByRunId));
  if (input.origin === "upload" || input.origin === "authored") filters.push(isNull(artifacts.producedByRunId));
  if (input.query?.trim()) filters.push(sql`${artifacts.title} ilike ${"%" + input.query.trim().replace(/[%_]/g, "\\$&") + "%"}`);
  const where = and(...filters);
  // The card preview is a 280-char slice; pulling the full content JSONB for
  // 200 rows to throw 99% of it away is the expensive way to get one. Truncate
  // in SQL: markdown text or the plain-text projection.
  const [countRow, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(artifacts).where(where),
    db
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        status: artifacts.status,
        producedByRunId: artifacts.producedByRunId,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
        contentText: sql<string | null>`case when ${artifactVersions.content} ->> 'kind' = 'markdown' then left(${artifactVersions.content} ->> 'text', ${PREVIEW_LENGTH}) end`,
        plainText: sql<string | null>`left(${artifactVersions.plainText}, ${PREVIEW_LENGTH})`,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(where)
      .orderBy(desc(artifacts.updatedAt))
      .limit(input.limit ?? 100)
      .offset(input.offset ?? 0),
  ]);

  return {
    total: countRow[0]?.total ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      origin: row.producedByRunId ? "run" : "authored",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // The preview is plain text by convention (lib/display-text): strip
      // whichever source wins - raw markers in a card read as corruption.
      // Stripping is marker-precise, so already-plain text passes through.
      preview: markdownToPlainText(row.plainText ?? row.contentText ?? ""),
    }) satisfies GalleryArtifact),
  };
}

export type ArtifactDetail = {
  id: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  updatedAt: Date;
  markdown: string | null;
  structured: unknown | null;
  plainText: string | null;
  /** True for a generated design brief that carries its structured form. */
  isDesignBrief: boolean;
  sources: { documentId: string; title: string }[];
};

/** One artifact with its full current version, or null when not in this workspace. */
export async function getArtifactDetail(auth: AuthContext, artifactId: string): Promise<ArtifactDetail | null> {
  const [artifact] = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      status: artifacts.status,
      version: artifacts.version,
      updatedAt: artifacts.updatedAt,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
    .limit(1);
  if (!artifact) return null;

  const [version] = artifact.currentVersionId
    ? await db
        .select({ content: artifactVersions.content, plainText: artifactVersions.plainText })
        .from(artifactVersions)
        .where(and(eq(artifactVersions.id, artifact.currentVersionId), eq(artifactVersions.workspaceId, auth.workspaceId)))
        .limit(1)
    : [null];

  const linkRows = await db
    .select({ targetId: artifactLinks.targetId })
    .from(artifactLinks)
    .where(and(eq(artifactLinks.artifactId, artifactId), eq(artifactLinks.workspaceId, auth.workspaceId), eq(artifactLinks.targetType, "document")));
  const documentIds = [...new Set(linkRows.map((l) => l.targetId))];
  const docs = documentIds.length
    ? await db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(and(inArray(documents.id, documentIds), eq(documents.workspaceId, auth.workspaceId)))
    : [];

  const content = (version?.content ?? null) as { kind?: string; text?: string; brief?: unknown } | null;
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    status: artifact.status,
    version: artifact.version,
    updatedAt: artifact.updatedAt,
    markdown: content?.kind === "markdown" && typeof content.text === "string" ? content.text : version?.plainText ?? null,
    structured: artifact.kind === "deck" || artifact.kind === "infographic" ? content : null,
    plainText: version?.plainText ?? null,
    isDesignBrief: briefFromContent(content) !== null,
    sources: docs.map((d) => ({ documentId: d.id, title: d.title })),
  };
}
