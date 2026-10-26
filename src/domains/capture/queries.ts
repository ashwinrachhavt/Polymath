import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL, isNull } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { captureProposals, captures } from "./schema";

/*
 * Inbox reads over the canonical captures table (ASH-137 A02). The original
 * material is immutable and survives conversion - converted rows keep their
 * text and gain the lineage edge (convertedType/convertedId) instead of
 * losing anything.
 */

export type InboxFilter = "unprocessed" | "parked" | "converted" | "discarded" | "all";

export const CAPTURE_KINDS = ["text", "url", "file", "voice", "forwarded"] as const;
export type CaptureKindFilter = (typeof CAPTURE_KINDS)[number];

/** The capture a URL-only duplicate collided with, so the notice can link to it. */
export async function findCaptureIdByUrl(
  auth: AuthContext,
  input: { source: (typeof captures.$inferSelect)["source"]; url: string },
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.source, input.source), eq(captures.url, input.url)))
    .limit(1);
  return row?.id;
}

function stateWhere(auth: AuthContext, filter: InboxFilter): SQL {
  return (
    filter === "all"
      ? eq(captures.workspaceId, auth.workspaceId)
      : filter === "converted"
        ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'converted'`
        : filter === "discarded"
          ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.processingState} = 'discarded'`
          : filter === "parked"
            ? sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.parkedAt} is not null and ${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`
            : sql`${captures.workspaceId} = ${auth.workspaceId} and ${captures.parkedAt} is null and ${captures.processingState} in ('unprocessed', 'classifying', 'enriched', 'failed')`
  );
}

export async function listCaptures(auth: AuthContext, filter: InboxFilter = "unprocessed", limit = 100) {
  return db.select().from(captures).where(stateWhere(auth, filter)).orderBy(desc(captures.createdAt)).limit(limit);
}

/** The row fields every list render needs; text is a 300-char preview, not the body. */
const listColumns = {
  id: captures.id,
  processingState: captures.processingState,
  parkedAt: captures.parkedAt,
  kind: captures.kind,
  createdAt: captures.createdAt,
  url: captures.url,
  version: captures.version,
  convertedType: captures.convertedType,
  convertedId: captures.convertedId,
  // Enrichment's short noun phrase; the list's label leads with it.
  title: captures.title,
  // A file capture has no text; its only searchable label is the filename.
  preview: sql<string | null>`coalesce(left(${captures.text}, 300), ${captures.rawPayload}->>'filename')`,
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
    // The filename matches search too - the file's CONTENTS stay unsearchable.
    parts.push(or(ilike(captures.text, like), ilike(captures.url, like), ilike(sql`${captures.rawPayload}->>'filename'`, like))!);
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
 * read here; a deleted capture lands on the inbox's empty-selection state.
 * The route is the durable /command-center/inbox (server-rendered, UUID-
 * validated ?id= selection) - NOT /apps/command-center/inbox, which is the
 * browser-only preview shell with sample data.
 */
export async function searchCapturesForLink(auth: AuthContext, query: string, limit = 3) {
  const like = `%${escapeLike(query.trim())}%`;
  const rows = await db
    .select({ id: captures.id, text: captures.text, url: captures.url })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), isNull(captures.archivedAt), or(ilike(captures.text, like), ilike(captures.url, like))!))
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(limit);
  return rows.map((row) => ({ id: row.id, title: captureLinkLabel(row), kind: "capture" as const, href: `/command-center/inbox?id=${row.id}` }));
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
      count(*) filter (where parked_at is null and processing_state in ('unprocessed', 'classifying', 'enriched', 'failed'))::int as to_clarify,
      count(*) filter (where parked_at is not null and processing_state in ('unprocessed', 'classifying', 'enriched', 'failed'))::int as parked,
      count(*) filter (where processing_state = 'converted')::int as converted,
      count(*) filter (where processing_state = 'discarded')::int as discarded,
      count(*)::int as all
    from captures
    where workspace_id = ${auth.workspaceId}
  `);
  const row = (rows as unknown as Array<Record<string, number>>)[0];
  return {
    unprocessed: row?.to_clarify ?? 0,
    parked: row?.parked ?? 0,
    converted: row?.converted ?? 0,
    discarded: row?.discarded ?? 0,
    all: row?.all ?? 0,
  };
}

export async function countToClarify(auth: AuthContext): Promise<number> {
  const tabs = await countInboxTabs(auth);
  return tabs.unprocessed;
}

/*
 * ASH-308: the theatre's capture strip - what arrived today, in arrival
 * order. Reads only; the strip never mutates the inbox. Day bounds arrive
 * pre-resolved (theatre-data owns the workspace-timezone math), so the query
 * itself stays a plain range read.
 */
export async function listCapturesArrivedBetween(auth: AuthContext, input: { from: Date; to: Date }, limit = 50) {
  return db
    .select({
      id: captures.id,
      title: captures.title,
      text: captures.text,
      url: captures.url,
      processingState: captures.processingState,
      createdAt: captures.createdAt,
    })
    .from(captures)
    .where(
      and(
        eq(captures.workspaceId, auth.workspaceId),
        gte(captures.createdAt, input.from),
        lt(captures.createdAt, input.to),
      ),
    )
    .orderBy(desc(captures.createdAt))
    .limit(limit);
}

/* --- Classification proposals (ASH-314) --- */

/*
 * The system's read of a capture, written by enrichment and decided by the
 * owner. Pending only: decided proposals are history, surfaced through the
 * capture's lineage edge instead.
 */
export async function listPendingCaptureProposals(auth: AuthContext, captureId: string) {
  return db
    .select()
    .from(captureProposals)
    .where(
      and(
        eq(captureProposals.workspaceId, auth.workspaceId),
        eq(captureProposals.captureId, captureId),
        eq(captureProposals.status, "pending"),
        // A parked capture's suggestions stay hidden until it is unparked (ASH-305).
        sql`not exists (select 1 from captures c where c.id = ${captureProposals.captureId} and c.parked_at is not null)`,
      ),
    )
    .orderBy(captureProposals.createdAt);
}

/**
 * Pending-proposal presence for a page of inbox rows, so the list can mark
 * which captures carry a suggestion without a join per row.
 */
export async function listCapturesWithPendingProposals(auth: AuthContext, captureIds: string[]): Promise<Set<string>> {
  if (!captureIds.length) return new Set();
  const rows = await db
    .selectDistinct({ captureId: captureProposals.captureId })
    .from(captureProposals)
    .where(
      and(
        eq(captureProposals.workspaceId, auth.workspaceId),
        inArray(captureProposals.captureId, captureIds),
        eq(captureProposals.status, "pending"),
        sql`not exists (select 1 from captures c where c.id = ${captureProposals.captureId} and c.parked_at is not null)`,
      ),
    );
  return new Set(rows.map((row) => row.captureId));
}
