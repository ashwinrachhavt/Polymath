import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";
import { sources } from "./schema";

/*
 * The one writer of `sources` rows for captured material. A source is the
 * citation identity that claims and dossiers point at; a capture path that
 * skipped it left the material readable but uncitable.
 *
 * Call inside the intake transaction, so a source exists exactly when the file
 * does. The partial unique index on (workspace, url, content_hash) makes the
 * insert idempotent: the same page captured twice, or a redelivered crawl,
 * inserts nothing the second time. A url-matched row without a hash (a
 * notebook's placeholder for a queued capture) is updated in place instead, so
 * one material is one row and the notebook's binding survives.
 *
 * `dossiers.ts` and `zettels.ts` build document-backed sources with their own
 * lookups (fileId-keyed, no URL); those stay where they are until a second
 * caller needs the same shape.
 */

export async function recordSource(
  auth: AuthContext,
  tx: TxDrizzle,
  input: {
    title: string;
    url: string;
    contentHash: string;
    /** "web" for a fetched page, "document" for an attached binary. */
    kind: "web" | "document";
    /** The provider's request id when one exists (Firecrawl job id), for reproducing a fetch. */
    providerRequestId?: string | null;
  },
): Promise<void> {
  // The partial unique index on (workspace, url, content_hash) makes the
  // insert idempotent for rows that already carry this version. A row written
  // earlier without the hash — the placeholder a notebook attach made for a
  // queued capture (dossiers.sourceFor) — has no row it can conflict with, so
  // an insert here would leave two rows for one material. Updating the
  // url-matched row first keeps one source per address: the placeholder gains
  // its content hash and the binding survives the capture landing.
  const updated = await tx
    .update(sources)
    .set({
      kind: input.kind,
      title: input.title,
      contentHash: input.contentHash,
      fetchedAt: new Date(),
      providerRequestId: input.providerRequestId ?? null,
      updatedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${sources.version} + 1`,
    })
    .where(and(
      eq(sources.workspaceId, auth.workspaceId),
      eq(sources.url, input.url),
      isNull(sources.contentHash),
    ))
    .returning({ id: sources.id });
  if (updated.length > 0) return;

  await tx
    .insert(sources)
    .values({
      workspaceId: auth.workspaceId,
      kind: input.kind,
      title: input.title,
      url: input.url,
      fileId: null,
      contentHash: input.contentHash,
      fetchedAt: new Date(),
      providerRequestId: input.providerRequestId ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing({
      target: [sources.workspaceId, sources.url, sources.contentHash],
      where: sql`url is not null and content_hash is not null`,
    });
}
