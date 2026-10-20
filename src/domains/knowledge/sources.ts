import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";
import { sources } from "./schema";

/*
 * The one writer of `sources` rows for captured material. A source is the
 * citation identity that claims and dossiers point at; a capture path that
 * skipped it left the material readable but uncitable.
 *
 * Call inside the intake transaction, so a source exists exactly when the file
 * does. The partial unique index on (workspace, url, content_hash) makes this
 * idempotent: the same page captured twice, or a redelivered crawl, inserts
 * nothing the second time.
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
  await tx
    .insert(sources)
    .values({
      workspaceId: auth.workspaceId,
      kind: input.kind,
      title: input.title,
      url: input.url,
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
