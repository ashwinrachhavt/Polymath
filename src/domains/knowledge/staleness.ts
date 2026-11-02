import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { artifactLinks, artifacts } from "./schema";

/*
 * Source staleness (plan task 23): when a document's extraction is replaced,
 * ideas decomposed from it learn that their source changed. The marker is a
 * namespaced merge into metadata — never a whole-metadata rewrite, so keys
 * other writers set survive — and it sets only metadata, never updated_at: a
 * stale idea must not jump to the top of a list sorted by recency. Reading
 * the badge is a metadata lookup; the debt report counts the stale ideas.
 */

export async function markDerivedIdeasStale(
  auth: AuthContext,
  input: { documentId: string; at?: Date },
): Promise<number> {
  const at = input.at ?? new Date();
  const rows = await db
    .update(artifacts)
    .set({
      metadata: sql`coalesce(${artifacts.metadata},'{}'::jsonb) || jsonb_build_object('sourceChangedAt', ${at.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(artifacts.workspaceId, auth.workspaceId),
        inArray(artifacts.kind, ["note", "zettel"]),
        // Only ideas that name this document as their source.
        sql`exists (select 1 from ${artifactLinks}
          where ${artifactLinks.artifactId} = ${artifacts.id}
            and ${artifactLinks.linkType} = 'source'
            and ${artifactLinks.targetType} = 'document'
            and ${artifactLinks.targetId} = ${input.documentId})`,
      ),
    )
    .returning({ id: artifacts.id });
  return rows.length;
}
