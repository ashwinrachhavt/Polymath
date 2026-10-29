import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { artifactVersions, artifacts, wikiPages } from "./schema";

/*
 * The kept-outputs list behind /polymath/artifacts: everything the assistant
 * generated that this workspace kept. Kept means the artifact is live (never
 * archived) and carries a machine-authored status - a Studio draft or kept
 * draft, a wiki page, an accepted zettel. Human notes and raw saved answers
 * are also artifacts of kind "note", so the boundary is the wiki registry: a
 * "note" kind row appears only when wiki_pages claims it. Conversations holds
 * the threads and Notes holds the pages a person wrote; this list is the
 * things those threads produced that were worth keeping.
 */

/**
 * The kinds the list offers as filters. "wiki" is not a db kind - wiki pages
 * are artifacts of kind "note" backed by a wiki_pages registry row - so it
 * filters by the registry join, not by artifacts.kind.
 */
export const ARTIFACT_KINDS = ["report", "deck", "infographic", "zettel", "wiki"] as const;
export type ArtifactKindFilter = (typeof ARTIFACT_KINDS)[number];

/** The statuses a kept artifact can carry. "published" is never set; "archived" is a discarded draft. */
export const ARTIFACT_STATUSES = ["draft", "generated", "reviewed"] as const;
export type ArtifactStatusFilter = (typeof ARTIFACT_STATUSES)[number];

const GENERATED_KINDS = ["report", "deck", "infographic", "zettel"] as const;

export type ArtifactRow = {
  id: string;
  title: string;
  /** The stored kind; "note" rows the wiki registry claims read as wiki. */
  kind: string;
  isWiki: boolean;
  status: string;
  updatedAt: Date;
  excerpt: string | null;
};

export type ArtifactList = { items: ArtifactRow[]; total: number };

export async function pageArtifacts(
  auth: AuthContext,
  input: { kind?: string; status?: string; query?: string; limit: number; offset: number },
): Promise<ArtifactList> {
  // The URL is the only source of these values, so an unknown one is "no
  // filter" rather than an empty page (same contract as parseListParams).
  const kind = (ARTIFACT_KINDS as readonly string[]).includes(input.kind ?? "")
    ? (input.kind as ArtifactKindFilter)
    : undefined;
  const status = (ARTIFACT_STATUSES as readonly string[]).includes(input.status ?? "")
    ? (input.status as ArtifactStatusFilter)
    : undefined;

  const filters = [
    eq(artifacts.workspaceId, auth.workspaceId),
    isNull(artifacts.archivedAt),
    inArray(artifacts.status, [...ARTIFACT_STATUSES]),
  ];
  if (kind === "wiki") {
    filters.push(isNotNull(wikiPages.id));
  } else if (kind) {
    filters.push(eq(artifacts.kind, kind));
  } else {
    // The default view: the generated kinds, plus note-kind rows the wiki
    // registry claims. Plain notes and saved answers stay out.
    filters.push(or(inArray(artifacts.kind, [...GENERATED_KINDS]), isNotNull(wikiPages.id))!);
  }
  if (status) filters.push(eq(artifacts.status, status));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(artifacts.title, like), ilike(artifactVersions.plainText, like))!);
  }
  const where = and(...filters);

  const wikiJoin = and(eq(wikiPages.artifactId, artifacts.id), eq(wikiPages.workspaceId, auth.workspaceId));
  const versionJoin = and(
    eq(artifactVersions.id, artifacts.currentVersionId),
    eq(artifactVersions.workspaceId, auth.workspaceId),
  );

  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      kind: artifacts.kind,
      status: artifacts.status,
      updatedAt: artifacts.updatedAt,
      wikiArtifactId: wikiPages.artifactId,
      // One excerpt line, at most 512 characters of blob: the full plain_text
      // can be megabytes per row and only ~240 characters ever render.
      excerpt: sql<string | null>`left(${artifactVersions.plainText}, 512)`,
    })
    .from(artifacts)
    .leftJoin(wikiPages, wikiJoin)
    .leftJoin(artifactVersions, versionJoin)
    .where(where)
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(input.limit)
    .offset(input.offset);
  // The count runs the same joins the page filter reads, so it counts the
  // same rows the list shows - the partial truth, never dressed whole.
  const [totalRow] = await db
    .select({ n: count() })
    .from(artifacts)
    .leftJoin(wikiPages, wikiJoin)
    .leftJoin(artifactVersions, versionJoin)
    .where(where);

  return {
    total: totalRow?.n ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      isWiki: row.wikiArtifactId !== null,
      status: row.status,
      updatedAt: row.updatedAt,
      excerpt: row.excerpt
        ? (row.excerpt.split("\n").map((l: string) => l.trim()).find((l: string) => l.length > 0) ?? null)?.slice(0, 240) ?? null
        : null,
    })),
  };
}
