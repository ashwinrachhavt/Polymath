import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { markdownToPlainText } from "@/lib/display-text";
import { briefFromContent } from "./design-brief-handoff";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifactLinks, artifactStatus, artifactVersions, artifacts, documents } from "./schema";
import { currentExtractionSql } from "./versions";

/*
 * The artifact gallery: every artifact in the workspace, generated or
 * imported, with enough of its content to render a preview card. The detail
 * read returns the full current version plus its pinned sources.
 */

export type GalleryArtifact = {
  recordType: "artifact" | "source" | "quiz" | "flashcard_deck";
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
  notebookId?: string | null;
  documentId?: string | null;
};

const PREVIEW_LENGTH = 280;

const isArtifactStatus = (value: string): value is (typeof artifactStatus.enumValues)[number] =>
  (artifactStatus.enumValues as readonly string[]).includes(value);

export async function listGalleryArtifacts(
  auth: AuthContext,
  input: {
    kind?:
      | "source"
      | "note"
      | "zettel"
      | "document"
      | "memo"
      | "report"
      | "diagram"
      | "transcript"
      | "deck"
      | "infographic"
      | "other"
      | "quiz"
      | "flashcards";
    origin?: "run" | "upload" | "authored";
    status?: string;
    query?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: GalleryArtifact[]; total: number }> {
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const escapedQuery = input.query?.trim().replace(/[%_]/g, "\\$&");
  const artifactFilters = [eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)];
  if (input.kind === "source" || input.kind === "quiz" || input.kind === "flashcards") artifactFilters.push(sql`false`);
  else if (input.kind) artifactFilters.push(eq(artifacts.kind, input.kind));
  if (input.origin === "run") artifactFilters.push(isNotNull(artifacts.producedByRunId));
  if (input.origin === "upload" || input.origin === "authored") artifactFilters.push(isNull(artifacts.producedByRunId));
  // Source-only statuses (pending, failed, ...) are not artifact_status values:
  // comparing would make Postgres reject the whole query, so they match no artifact.
  if (input.status)
    artifactFilters.push(isArtifactStatus(input.status) ? eq(artifacts.status, input.status) : sql`false`);
  if (escapedQuery)
    artifactFilters.push(
      sql`(${artifacts.title} ilike ${`%${escapedQuery}%`} or exists (select 1 from artifact_versions av where av.id = ${artifacts.currentVersionId} and av.plain_text ilike ${`%${escapedQuery}%`}))`,
    );
  const artifactWhere = and(...artifactFilters);

  const sourceFilters = [eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)];
  if (input.kind && input.kind !== "source") sourceFilters.push(sql`false`);
  if (input.origin === "run" || input.origin === "authored") sourceFilters.push(sql`false`);
  if (input.status) sourceFilters.push(sql`coalesce(${currentExtractionSql("status")}, 'pending') = ${input.status}`);
  if (escapedQuery)
    sourceFilters.push(
      sql`(${documents.title} ilike ${`%${escapedQuery}%`} or ${currentExtractionSql("text")} ilike ${`%${escapedQuery}%`})`,
    );
  const sourceWhere = and(...sourceFilters);

  const [artifactCount, artifactRows, sourceCount, sourceRows] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(artifacts)
      .where(artifactWhere),
    db
      .select({
        id: artifacts.id,
        title: artifacts.title,
        kind: artifacts.kind,
        status: artifacts.status,
        producedByRunId: artifacts.producedByRunId,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
        contentText: sql<
          string | null
        >`case when ${artifactVersions.content} ->> 'kind' = 'markdown' then left(${artifactVersions.content} ->> 'text', ${PREVIEW_LENGTH}) end`,
        plainText: sql<string | null>`left(${artifactVersions.plainText}, ${PREVIEW_LENGTH})`,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(artifactWhere)
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(limit + offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(documents)
      .where(sourceWhere),
    db
      .select({
        id: documents.id,
        title: documents.title,
        status: sql<string>`coalesce(${currentExtractionSql("status")}, 'pending')`,
        preview: sql<string | null>`left(${currentExtractionSql("text")}, ${PREVIEW_LENGTH})`,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(sourceWhere)
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(limit + offset),
  ]);

  const items: GalleryArtifact[] = [
    ...artifactRows.map((row) => ({
      recordType: "artifact" as const,
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      origin: row.producedByRunId ? ("run" as const) : ("authored" as const),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: markdownToPlainText(row.plainText ?? row.contentText ?? ""),
    })),
    ...sourceRows.map((row) => ({
      recordType: "source" as const,
      id: row.id,
      title: row.title,
      kind: "source",
      status: row.status,
      origin: "upload" as const,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: markdownToPlainText(row.preview ?? ""),
    })),
  ];
  items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
  return {
    total: (artifactCount[0]?.total ?? 0) + (sourceCount[0]?.total ?? 0),
    items: items.slice(offset, offset + limit),
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
        .where(
          and(eq(artifactVersions.id, artifact.currentVersionId), eq(artifactVersions.workspaceId, auth.workspaceId)),
        )
        .limit(1)
    : [null];

  const linkRows = await db
    .select({ targetId: artifactLinks.targetId })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.artifactId, artifactId),
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.targetType, "document"),
      ),
    );
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
    markdown:
      content?.kind === "markdown" && typeof content.text === "string" ? content.text : (version?.plainText ?? null),
    structured: artifact.kind === "deck" || artifact.kind === "infographic" ? content : null,
    plainText: version?.plainText ?? null,
    isDesignBrief: briefFromContent(content) !== null,
    sources: docs.map((d) => ({ documentId: d.id, title: d.title })),
  };
}
