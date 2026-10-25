import { and, desc, eq, ilike, inArray, isNull, notInArray, or } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { canonicalCaptureUrl, parseCaptureUrl } from "@/lib/safe-fetch";
import { artifactLinks, artifacts, artifactVersions, documents } from "./schema";
import { firstLine } from "./relations";

/*
 * "Shown what I already wrote about it" (Product Spec, Capture stories): a
 * URL the person already captured is not a dead end. For one URL this read
 * collects what the workspace already holds about it, in two honestly
 * labelled groups:
 *
 *   from-page - cards carrying a `source` edge to the library document the
 *               URL canonicalizes to (accepted zettels, saved answers,
 *               generated drafts). This is the graph's own provenance, exact.
 *   mentions  - notes and zettels whose current text contains the URL as a
 *               plain substring. A mention is a mention; similarity is never
 *               claimed.
 *
 * A card in from-page is excluded from mentions, so nothing lists twice. The
 * read is a view over artifact_links and current artifact versions - it
 * writes nothing and cannot drift.
 */

export type PriorWritingBasis = "from-page" | "mentions";

export type PriorWritingItem = {
  id: string;
  kind: string;
  title: string;
  excerpt: string | null;
  basis: PriorWritingBasis;
};

export type PriorWriting = {
  /** The library document the URL resolves to, when one exists. */
  documentId: string | null;
  items: PriorWritingItem[];
};

const PER_GROUP = 3;

const empty: PriorWriting = { documentId: null, items: [] };

export async function listPriorWritingForUrl(
  auth: AuthContext,
  input: { url: string },
): Promise<PriorWriting> {
  // Parsing only - nothing is fetched, so private addresses are allowed here;
  // the fetch-time screen stays with captureUrl.
  const parsed = parseCaptureUrl(input.url, true);
  if (!parsed.ok) return empty;
  const canonical = canonicalCaptureUrl(parsed.url);
  const raw = input.url.trim();

  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, canonical)))
    .limit(1);

  const fromPageRows = document
    ? await db
        .select({
          id: artifacts.id,
          kind: artifacts.kind,
          title: artifacts.title,
          plainText: artifactVersions.plainText,
        })
        .from(artifactLinks)
        .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
        .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.linkType, "source"),
          eq(artifactLinks.targetType, "document"),
          eq(artifactLinks.targetId, document.id),
          eq(artifacts.workspaceId, auth.workspaceId),
          isNull(artifacts.archivedAt),
        ))
        .orderBy(desc(artifacts.updatedAt))
        .limit(PER_GROUP)
    : [];

  const patterns = [...new Set([raw, canonical])].map((value) => `%${escapeLike(value)}%`);
  const fromPageIds = fromPageRows.map((row) => row.id);
  const mentionRows = await db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      plainText: artifactVersions.plainText,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(
      eq(artifacts.workspaceId, auth.workspaceId),
      inArray(artifacts.kind, ["note", "zettel"]),
      isNull(artifacts.archivedAt),
      or(...patterns.map((pattern) => ilike(artifactVersions.plainText, pattern))),
      fromPageIds.length ? notInArray(artifacts.id, fromPageIds) : undefined,
    ))
    .orderBy(desc(artifacts.updatedAt))
    .limit(PER_GROUP);

  const toItem = (basis: PriorWritingBasis) => (row: { id: string; kind: string; title: string; plainText: string | null }): PriorWritingItem => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    excerpt: firstLine(row.plainText),
    basis,
  });

  return {
    documentId: document?.id ?? null,
    items: [...fromPageRows.map(toItem("from-page")), ...mentionRows.map(toItem("mentions"))],
  };
}
