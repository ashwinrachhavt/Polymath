import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { captures } from "./schema";

/*
 * Inbox reads over the canonical captures table (ASH-137 A02). The original
 * material is immutable and survives conversion - converted rows keep their
 * text and gain the lineage edge (convertedType/convertedId) instead of
 * losing anything.
 */

export type InboxFilter = "unprocessed" | "converted" | "discarded" | "all";

export const CAPTURE_KINDS = ["text", "url", "file", "voice", "forwarded"] as const;
export type CaptureKindFilter = (typeof CAPTURE_KINDS)[number];

function stateWhere(auth: AuthContext, filter: InboxFilter): SQL {
  return (
    filter === "all"
      ? eq(captures.workspaceId, auth.workspaceId)
      : filter === "converted"
        ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'converted'`
        : filter === "discarded"
          ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'discarded'`
          : sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`
  );
}

export async function listCaptures(auth: AuthContext, filter: InboxFilter = "unprocessed", limit = 100) {
  return db.select().from(captures).where(stateWhere(auth, filter)).orderBy(desc(captures.createdAt)).limit(limit);
}

/** Paged, searchable read for the inbox screen. The total honours every filter. */
export async function searchCaptures(
  auth: AuthContext,
  input: { filter?: InboxFilter; kind?: CaptureKindFilter; query?: string; limit: number; offset: number },
) {
  const parts: SQL[] = [stateWhere(auth, input.filter ?? "unprocessed")];
  if (input.kind) parts.push(eq(captures.kind, input.kind));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    parts.push(or(ilike(captures.text, like), ilike(captures.url, like))!);
  }
  const where = and(...parts);
  const [items, [totalRow]] = await Promise.all([
    db.select().from(captures).where(where).orderBy(desc(captures.createdAt), desc(captures.id)).limit(input.limit).offset(input.offset),
    db.select({ total: count() }).from(captures).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

export async function countToClarify(auth: AuthContext): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as n from captures
    where workspace_id = ${auth.workspaceId}
      and processing_state in ('unprocessed', 'classifying', 'enriched', 'failed')
  `);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}
