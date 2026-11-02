/**
 * SQL-side reads for dispatch passes — the async half of the store.
 *
 * The synchronous repositories read whole aggregates; these queries read only
 * the slices the post-commit passes need, and lean on the generated columns and
 * partial indexes so a pass never scans settled work: `is_active` on threads
 * and tickets, `needs_attention` on effects, and the pending-status partial
 * indexes. Every read is workspace-scoped.
 */
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ticketRuns, workEffects, workOutboxReceipts, workSubscriptions, workThreads, workTickets } from "./schema";

/** WorkThreads with Triggers queued for Eval or an Eval in progress. */
export function activeThreads(db: PostgresJsDatabase, workspaceId: string) {
  return db
    .select({ key: workThreads.key })
    .from(workThreads)
    .where(and(eq(workThreads.workspaceId, workspaceId), eq(workThreads.isActive, true)));
}

/** Tickets with undelivered Inputs or a pending or running TicketRun. */
export function activeTickets(db: PostgresJsDatabase, workspaceId: string) {
  return db
    .select({ id: workTickets.id })
    .from(workTickets)
    .where(and(eq(workTickets.workspaceId, workspaceId), eq(workTickets.isActive, true)))
    .orderBy(asc(workTickets.seq));
}

/** Tickets that have not ended, newest first. */
export function openTickets(db: PostgresJsDatabase, workspaceId: string) {
  return db
    .select({ id: workTickets.id })
    .from(workTickets)
    .where(and(eq(workTickets.workspaceId, workspaceId), isNull(workTickets.endedAt)))
    .orderBy(desc(workTickets.seq));
}

/** The tickets a thread's triggers reach, by projection kind: subscriptions receive work, context only observes. */
export function ticketsForThread(
  db: PostgresJsDatabase,
  workspaceId: string,
  threadKey: string,
  kind: "subscription" | "context",
) {
  return db
    .select({ ticketId: workSubscriptions.ticketId })
    .from(workSubscriptions)
    .where(
      and(
        eq(workSubscriptions.workspaceId, workspaceId),
        eq(workSubscriptions.threadKey, threadKey),
        eq(workSubscriptions.kind, kind),
      ),
    );
}

/** A ticket's runs, oldest first — the dispatch pass's concurrency and recovery reads. */
export function runsForTicket(db: PostgresJsDatabase, workspaceId: string, ticketId: string) {
  return db
    .select()
    .from(ticketRuns)
    .where(and(eq(ticketRuns.workspaceId, workspaceId), eq(ticketRuns.ticketId, ticketId)))
    .orderBy(asc(ticketRuns.seq));
}

/** Effects ready to run, oldest available first; the pass claims a slice of these. */
export function dueEffects(db: PostgresJsDatabase, workspaceId: string, at: Date, limit = 20) {
  return db
    .select({ id: workEffects.id, kind: workEffects.kind, key: workEffects.key, attempts: workEffects.attempts })
    .from(workEffects)
    .where(
      and(
        eq(workEffects.workspaceId, workspaceId),
        eq(workEffects.status, "pending"),
        lte(workEffects.availableAt, at),
      ),
    )
    .orderBy(asc(workEffects.availableAt))
    .limit(limit);
}

/** Effects that failed three times in a row: a health entry, not a dead letter. */
export function attentionEffects(db: PostgresJsDatabase, workspaceId: string) {
  return db
    .select({ id: workEffects.id, kind: workEffects.kind, key: workEffects.key, lastError: workEffects.lastError })
    .from(workEffects)
    .where(and(eq(workEffects.workspaceId, workspaceId), eq(workEffects.needsAttention, true)));
}

/** Receipts still waiting to go out, in insertion order — per-conversation order rides on the global one. */
export function pendingReceipts(db: PostgresJsDatabase, workspaceId: string, limit = 50) {
  return db
    .select({
      id: workOutboxReceipts.id,
      channel: workOutboxReceipts.channel,
      text: workOutboxReceipts.text,
      kind: workOutboxReceipts.kind,
      ticketId: workOutboxReceipts.ticketId,
    })
    .from(workOutboxReceipts)
    .where(and(eq(workOutboxReceipts.workspaceId, workspaceId), eq(workOutboxReceipts.status, "pending")))
    .orderBy(asc(workOutboxReceipts.seq))
    .limit(limit);
}
