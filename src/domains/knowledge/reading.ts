import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { currentExtractionSql } from "./versions";
import { withTransaction } from "@/lib/db-transaction";
import {
  documentReadingEvents,
  documentReadingState,
  documents,
  documentExtractions,
  files,
  type ReadingEventKind,
} from "./schema";

/*
 * D18 (ASH-144): reading history and engagement on the canonical document
 * store. One entry point (recordReadingEvent) keeps the write rules in one
 * place: the document must belong to the workspace, progress clamps to 0..1,
 * active seconds cap at four hours per event so a wedged tab cannot inflate
 * engagement, and a client_event_id makes a retried send fold exactly once.
 *
 * The fold is pure (foldReadingEvent) so the state machine is unit-tested
 * without a database; the command applies it inside the same transaction as
 * the event insert, so events and the derived state can never disagree.
 */

export class ReadingDocumentMissingError extends Error {
  readonly code = "reading_document_missing";
}

/** Per-event ceiling: four hours of "active" time. Longer is a wedged tab, not reading. */
export const MAX_ACTIVE_SECONDS = 4 * 60 * 60;
/** A document counts as finished at 98% - the last scroll fraction is routinely unreachable. */
export const FINISHED_AT = 0.98;
/** Below this a document is "started", not yet a real reading position. */
export const STARTED_AT = 0.02;

export const clampProgress = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.min(1, Math.max(0, value));
};

export const clampActiveSeconds = (value: number | null | undefined): number => {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(MAX_ACTIVE_SECONDS, Math.floor(value));
};

export type ReadingStateFold = {
  openCount: number;
  totalActiveSeconds: number;
  furthestProgress: number;
  lastPage: number | null;
};

export type ReadingEventInput = {
  kind: ReadingEventKind;
  progress?: number | null;
  page?: number | null;
  activeSeconds?: number | null;
};

/**
 * The state transition, pure. opened counts a sitting and moves lastOpenedAt;
 * progress only ever raises furthest_progress; every event may add its
 * active-seconds delta. A repeated open of the same visit still counts - the
 * reader opens once per mount and the client_event_id, not the fold, is what
 * swallows retries.
 */
export function foldReadingEvent(state: ReadingStateFold, event: ReadingEventInput): ReadingStateFold {
  const seconds = clampActiveSeconds(event.activeSeconds);
  const progress = clampProgress(event.progress);
  return {
    openCount: state.openCount + (event.kind === "opened" ? 1 : 0),
    totalActiveSeconds: state.totalActiveSeconds + seconds,
    furthestProgress: progress === null ? state.furthestProgress : Math.max(state.furthestProgress, progress),
    lastPage: event.page ?? state.lastPage,
  };
}

export const EMPTY_READING_STATE: ReadingStateFold = {
  openCount: 0,
  totalActiveSeconds: 0,
  furthestProgress: 0,
  lastPage: null,
};

export async function recordReadingEvent(
  auth: AuthContext,
  input: {
    documentId: string;
    visitId: string;
    kind: ReadingEventKind;
    progress?: number | null;
    page?: number | null;
    activeSeconds?: number | null;
    clientEventId?: string;
  },
) {
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.clientEventId,
      { op: "recordReadingEvent", ...input },
      async () => {
        const [doc] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.workspaceId, auth.workspaceId),
              eq(documents.id, input.documentId),
              isNull(documents.archivedAt),
            ),
          )
          .limit(1);
        if (!doc) throw new ReadingDocumentMissingError("That document does not exist in this workspace.");

        const progress = clampProgress(input.progress);
        const activeSeconds = clampActiveSeconds(input.activeSeconds);

        const [event] = await tx
          .insert(documentReadingEvents)
          .values({
            workspaceId: auth.workspaceId,
            documentId: input.documentId,
            userId: auth.userId,
            visitId: input.visitId,
            kind: input.kind,
            progress,
            page: input.page ?? null,
            activeSeconds,
            clientEventId: input.clientEventId ?? null,
            createdBy: auth.userId,
          })
          .onConflictDoNothing({
            target: [
              documentReadingEvents.workspaceId,
              documentReadingEvents.documentId,
              documentReadingEvents.userId,
              documentReadingEvents.clientEventId,
            ],
            where: sql`client_event_id is not null`,
          })
          .returning({ id: documentReadingEvents.id });

        if (!event) {
          // The partial unique index swallowed a retried send: fold nothing twice.
          const [state] = await tx
            .select()
            .from(documentReadingState)
            .where(
              and(
                eq(documentReadingState.workspaceId, auth.workspaceId),
                eq(documentReadingState.documentId, input.documentId),
                eq(documentReadingState.userId, auth.userId),
              ),
            )
            .limit(1);
          return { eventId: null as string | null, replayed: true, state: state ?? null };
        }

        const [existing] = await tx
          .select()
          .from(documentReadingState)
          .where(
            and(
              eq(documentReadingState.workspaceId, auth.workspaceId),
              eq(documentReadingState.documentId, input.documentId),
              eq(documentReadingState.userId, auth.userId),
            ),
          )
          .limit(1);

        const folded = foldReadingEvent(existing ?? EMPTY_READING_STATE, input);

        const [state] = existing
          ? await tx
              .update(documentReadingState)
              .set({
                openCount: folded.openCount,
                totalActiveSeconds: folded.totalActiveSeconds,
                furthestProgress: folded.furthestProgress,
                lastPage: folded.lastPage,
                lastOpenedAt: input.kind === "opened" ? sql`now()` : undefined,
                updatedBy: auth.userId,
                updatedAt: sql`now()`,
                version: sql`${documentReadingState.version} + 1`,
              })
              .where(eq(documentReadingState.id, existing.id))
              .returning()
          : await tx
              .insert(documentReadingState)
              .values({
                workspaceId: auth.workspaceId,
                documentId: input.documentId,
                userId: auth.userId,
                openCount: folded.openCount,
                totalActiveSeconds: folded.totalActiveSeconds,
                furthestProgress: folded.furthestProgress,
                lastPage: folded.lastPage,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              })
              .returning();

        if (input.kind === "closed" && folded.furthestProgress >= FINISHED_AT) {
          await recordAudit(
            auth,
            {
              action: "document.read_finished",
              subjectType: "document",
              subjectId: input.documentId,
              summary: "Finished reading a document",
            },
            tx,
          );
        }
        return { eventId: event.id, replayed: false, state };
      },
    );
    // A retried send returns the stored first response; the receipt's own
    // flag is the one that says this call folded nothing new.
    return replayed ? { ...value, replayed: true } : value;
  });
}

export type LibraryRow = {
  id: string;
  title: string;
  kind: "web_page" | "file";
  sourceUrl: string | null;
  mimeType: string | null;
  extractionStatus: string | null;
  createdAt: Date;
  state: {
    lastOpenedAt: Date;
    openCount: number;
    totalActiveSeconds: number;
    furthestProgress: number;
  } | null;
};

/** Every readable document with the caller's folded reading state, freshest activity first. */
export async function listLibrary(auth: AuthContext, limit = 200): Promise<LibraryRow[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      mimeType: documents.mimeType,
      sourceUrl: documents.sourceUrl,
      createdAt: documents.createdAt,
      filename: files.filename,
      extractionStatus: sql<string | null>`${currentExtractionSql("status")}`,
      stateLastOpenedAt: documentReadingState.lastOpenedAt,
      stateOpenCount: documentReadingState.openCount,
      stateTotalActiveSeconds: documentReadingState.totalActiveSeconds,
      stateFurthestProgress: documentReadingState.furthestProgress,
    })
    .from(documents)
    .leftJoin(files, eq(files.id, documents.fileId))
    .leftJoin(
      documentReadingState,
      and(
        eq(documentReadingState.documentId, documents.id),
        eq(documentReadingState.userId, auth.userId),
      ),
    )
    .where(and(eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)))
    .orderBy(desc(sql`coalesce(${documentReadingState.lastOpenedAt}, ${documents.createdAt})`))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.sourceUrl ? ("web_page" as const) : ("file" as const),
    sourceUrl: row.sourceUrl,
    mimeType: row.mimeType ?? row.filename ?? null,
    extractionStatus: row.extractionStatus,
    createdAt: row.createdAt,
    state:
      row.stateLastOpenedAt === null
        ? null
        : {
            lastOpenedAt: row.stateLastOpenedAt,
            openCount: row.stateOpenCount ?? 0,
            totalActiveSeconds: row.stateTotalActiveSeconds ?? 0,
            furthestProgress: row.stateFurthestProgress ?? 0,
          },
  }));
}

export type LibraryGroup = "continue" | "unread" | "finished";

/** The three library sections. Pure so the grouping rule is unit-tested. */
export function libraryGroup(row: Pick<LibraryRow, "state" | "extractionStatus">): LibraryGroup {
  const progress = row.state?.furthestProgress ?? 0;
  if (progress >= FINISHED_AT) return "finished";
  if (row.state && progress >= STARTED_AT) return "continue";
  return "unread";
}

export type ReadingHistoryRow = {
  documentId: string;
  title: string;
  lastOpenedAt: Date;
  openCount: number;
  totalActiveSeconds: number;
  furthestProgress: number;
};

/** Most recently opened documents - the history rail. */
export async function readingHistory(auth: AuthContext, limit = 20): Promise<ReadingHistoryRow[]> {
  const rows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      lastOpenedAt: documentReadingState.lastOpenedAt,
      openCount: documentReadingState.openCount,
      totalActiveSeconds: documentReadingState.totalActiveSeconds,
      furthestProgress: documentReadingState.furthestProgress,
    })
    .from(documentReadingState)
    .innerJoin(
      documents,
      and(eq(documents.id, documentReadingState.documentId), isNull(documents.archivedAt)),
    )
    .where(
      and(
        eq(documentReadingState.workspaceId, auth.workspaceId),
        eq(documentReadingState.userId, auth.userId),
      ),
    )
    .orderBy(desc(documentReadingState.lastOpenedAt))
    .limit(limit);
  return rows;
}

export type ReadableDocument = {
  id: string;
  title: string;
  kind: "web_page" | "file";
  sourceUrl: string | null;
  mimeType: string | null;
  pageCount: number | null;
  extraction: { status: string; text: string | null; error: string | null } | null;
  state: ReadingStateFold | null;
};

/** The reader's document: latest extraction text plus the caller's folded state. */
export async function getReadableDocument(
  auth: AuthContext,
  documentId: string,
): Promise<ReadableDocument | null> {
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      mimeType: documents.mimeType,
      sourceUrl: documents.sourceUrl,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, auth.workspaceId),
        eq(documents.id, documentId),
        isNull(documents.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [extraction, state] = await Promise.all([
    db
      .select({
        status: documentExtractions.status,
        text: documentExtractions.text,
        error: documentExtractions.error,
      })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({
        openCount: documentReadingState.openCount,
        totalActiveSeconds: documentReadingState.totalActiveSeconds,
        furthestProgress: documentReadingState.furthestProgress,
        lastPage: documentReadingState.lastPage,
      })
      .from(documentReadingState)
      .where(
        and(
          eq(documentReadingState.workspaceId, auth.workspaceId),
          eq(documentReadingState.documentId, documentId),
          eq(documentReadingState.userId, auth.userId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  return {
    id: row.id,
    title: row.title,
    kind: row.sourceUrl ? "web_page" : "file",
    sourceUrl: row.sourceUrl,
    mimeType: row.mimeType,
    pageCount: row.pageCount,
    extraction,
    state,
  };
}
