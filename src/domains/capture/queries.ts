import { desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { captures } from "./schema";

/*
 * Inbox reads over the canonical captures table (ASH-137 A02). The original
 * material is immutable and survives conversion - converted rows keep their
 * text and gain the lineage edge (convertedType/convertedId) instead of
 * losing anything.
 */

export type InboxFilter = "unprocessed" | "converted" | "discarded" | "all";

export async function listCaptures(auth: AuthContext, filter: InboxFilter = "unprocessed", limit = 100) {
  const where =
    filter === "all"
      ? eq(captures.workspaceId, auth.workspaceId)
      : filter === "converted"
        ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'converted'`
        : filter === "discarded"
          ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'discarded'`
          : sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`;
  return db.select().from(captures).where(where).orderBy(desc(captures.createdAt)).limit(limit);
}

export async function countToClarify(auth: AuthContext): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as n from captures
    where workspace_id = ${auth.workspaceId}
      and processing_state in ('unprocessed', 'classifying', 'enriched', 'failed')
  `);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}
