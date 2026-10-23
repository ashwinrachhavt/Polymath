import { and, count, desc, eq, ilike, or, sql, type SQL, isNull } from "drizzle-orm";
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

/** The row fields every list render needs; text is a 300-char preview, not the body. */
const listColumns = {
  id: captures.id,
  processingState: captures.processingState,
  kind: captures.kind,
  createdAt: captures.createdAt,
  url: captures.url,
  version: captures.version,
  convertedType: captures.convertedType,
  convertedId: captures.convertedId,
  preview: sql<string | null>`left(${captures.text}, 300)`,
};

/** Paged, searchable read for the inbox list pane. The total honours every filter. */
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
    db.select(listColumns).from(captures).where(where).orderBy(desc(captures.createdAt), desc(captures.id)).limit(input.limit).offset(input.offset),
    db.select({ total: count() }).from(captures).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

/** A capture's display label for link pickers: the first text line, else the URL host. */
export function captureLinkLabel(row: { text: string | null; url: string | null }): string {
  const line = row.text?.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (line) return line.length > 60 ? `${line.slice(0, 57)}...` : line;
  if (row.url) {
    try {
      return new URL(row.url).hostname;
    } catch {
      return row.url;
    }
  }
  return "Untitled capture";
}

/*
 * Link-target matches for the note editor's [[ ]] picker (row 36): any
 * unarchived capture in this workspace whose text or URL matches, labeled and
 * routed to its canonical inbox destination. Tenant-scoped like every other
 * read here; a deleted capture 404s into the inbox's empty-selection state.
 */
export async function searchCapturesForLink(auth: AuthContext, query: string, limit = 3) {
  const like = `%${escapeLike(query.trim())}%`;
  const rows = await db
    .select({ id: captures.id, text: captures.text, url: captures.url })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), isNull(captures.archivedAt), or(ilike(captures.text, like), ilike(captures.url, like))!))
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, title: captureLinkLabel(row), kind: "capture" as const, href: `/apps/command-center/inbox?id=${row.id}` }));
}

/** The full row for the detail pane; the only inbox read that carries the whole text. */
export async function getCapture(auth: AuthContext, id: string) {
  const [row] = await db
    .select()
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, id)))
    .limit(1);
  return row ?? null;
}

/** One count per inbox filter tab, in one round trip. */
export async function countInboxTabs(auth: AuthContext): Promise<Record<InboxFilter, number>> {
  const rows = await db.execute(sql`
    select
      count(*) filter (where processing_state in ('unprocessed', 'classifying', 'enriched', 'failed'))::int as to_clarify,
      count(*) filter (where processing_state = 'converted')::int as converted,
      count(*) filter (where processing_state = 'discarded')::int as discarded,
      count(*)::int as all
    from captures
    where workspace_id = ${auth.workspaceId}
  `);
  const row = (rows as unknown as Array<Record<string, number>>)[0];
  return {
    unprocessed: row?.to_clarify ?? 0,
    converted: row?.converted ?? 0,
    discarded: row?.discarded ?? 0,
    all: row?.all ?? 0,
  };
}

export async function countToClarify(auth: AuthContext): Promise<number> {
  const tabs = await countInboxTabs(auth);
  return tabs.unprocessed;
}
