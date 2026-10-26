import { and, eq } from "drizzle-orm";
import { capabilityAllowed, lowestTierId } from "@/domains/integrations/capabilities";
import { externalAccounts, syncCursors, triggers } from "@/domains/integrations/schema";
import { searchGmailMessages } from "@/domains/integrations/gmail/reads";
import type { Transport } from "@/domains/integrations/transport";
import { db } from "@/lib/db";
import { proposeContactsFromSenders, type ProposeFromSendersResult, type SenderMessage } from "./propose-from-senders";

/*
 * ASH-287, the arrival half: a polling pass over one connected Gmail account
 * that feeds new inbound senders to proposeContactsFromSenders. It mirrors the
 * Google Calendar sync (read-only against the provider, a watermark in
 * sync_cursors) and adds nothing else: no mail is written, labelled or sent,
 * and the only effect is review-queue proposals the owner approves or rejects.
 *
 * It is opt-in per account. Reading someone's inbox on a schedule is a
 * stronger grant than answering a question in a chat run, so a pass refuses
 * unless the owner has an `enabled` trigger (provider gmail, event type
 * SENDER_PROPOSALS_EVENT) for that account. It also honours the same live
 * checks the gateway applies to a run: account active, read allowed, and the
 * gmail.read capability inside the account's tier and not switched off.
 *
 * Cadence is whatever drives it. The repo's only scheduler is the daily Vercel
 * cron, so "arrives" means "within a day" until a push trigger (Composio Gmail
 * webhook) exists; that would call the same function.
 */

export const SENDER_PROPOSALS_EVENT = "crm.sender_proposals";
const RESOURCE = "sender-proposals";
const FIRST_RUN_LOOKBACK_SECONDS = 7 * 86_400;
const DEFAULT_PER_RUN = 25;
const MAX_PER_RUN = 50;

export class SenderSyncError extends Error {
  constructor(
    readonly code: "account_not_found" | "not_enabled" | "read_not_allowed" | "no_connection",
    message: string,
  ) {
    super(message);
    this.name = "SenderSyncError";
  }
}

export type SenderSyncResult = ProposeFromSendersResult & { scanned: number; complete: boolean };

const MAX_MESSAGES_PER_PASS = 200;
/** Re-read this much before the pass start next time; Gmail's index can lag a few seconds. */
const OVERLAP_SECONDS = 120;

/** `before` null = open-ended (now). Both bounds are Gmail receipt time in epoch seconds. */
export type Window = { after: number; before: number | null };
export type SenderCursor = { watermark: number | null; pending: Window[] };

export function parseCursor(raw: string | null | undefined): SenderCursor {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<SenderCursor>) : {};
    const pending = Array.isArray(value.pending)
      ? value.pending.filter((w): w is Window => typeof w?.after === "number" && (w.before === null || typeof w.before === "number"))
      : [];
    return { watermark: typeof value.watermark === "number" ? value.watermark : null, pending };
  } catch {
    // An unreadable cursor falls back to the bounded first-run lookback, never to "everything".
    return { watermark: null, pending: [] };
  }
}

/** Promotional and bulk categories are never people; Gmail's own classifier keeps them out of the scan. */
export function buildSenderQuery(window: Window): string {
  return `in:inbox -from:me -category:promotions -category:social -category:updates -category:forums after:${window.after}${window.before === null ? "" : ` before:${window.before}`}`;
}

export async function syncGmailSenders(
  workspaceId: string,
  input: { externalAccountId: string; transport: Transport; now?: Date },
): Promise<SenderSyncResult> {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const [account] = await db
    .select()
    .from(externalAccounts)
    .where(and(eq(externalAccounts.id, input.externalAccountId), eq(externalAccounts.workspaceId, workspaceId)))
    .limit(1);
  if (!account || account.provider !== "gmail") throw new SenderSyncError("account_not_found", "No Gmail account with that id in this workspace.");
  if (!account.composioConnectedAccountId || account.status !== "active") throw new SenderSyncError("no_connection", "This Gmail account is not connected.");
  const tier = account.accessTier ?? lowestTierId("gmail");
  if (!account.allowRead || !tier || !capabilityAllowed("gmail", tier, account.disabledCapabilities as string[], "gmail.read")) {
    throw new SenderSyncError("read_not_allowed", "Agent read access is off for this Gmail account.");
  }

  const [trigger] = await db
    .select()
    .from(triggers)
    .where(
      and(
        eq(triggers.workspaceId, workspaceId),
        eq(triggers.externalAccountId, account.id),
        eq(triggers.provider, "gmail"),
        eq(triggers.eventType, SENDER_PROPOSALS_EVENT),
        eq(triggers.status, "enabled"),
      ),
    )
    .limit(1);
  if (!trigger) throw new SenderSyncError("not_enabled", "Contact suggestions from new senders are not turned on for this account.");
  const triggerBudget = trigger.budget as { perRun?: number };
  const limit = Math.max(1, Math.min(triggerBudget.perRun ?? DEFAULT_PER_RUN, MAX_PER_RUN));

  const [cursorRow] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, RESOURCE)))
    .limit(1);
  const saved = parseCursor(cursorRow?.cursor);

  const recordCursor = (cursor: SenderCursor | null, state: "idle" | "partial" | "failed", lastError: string | null) =>
    db
      .insert(syncCursors)
      .values({ workspaceId, externalAccountId: account.id, resource: RESOURCE, cursor: cursor ? JSON.stringify(cursor) : null, state, lastError, lastSyncedAt: new Date() })
      .onConflictDoUpdate({
        target: [syncCursors.externalAccountId, syncCursors.resource],
        set: { ...(cursor ? { cursor: JSON.stringify(cursor) } : {}), state, lastError, lastSyncedAt: new Date(), updatedAt: new Date() },
      });

  /*
   * Work is a list of time windows over Gmail's own receipt time: any windows a
   * previous pass could not finish, then everything since the watermark. Each
   * window is read newest-first in pages, and a full page shrinks the window to
   * end just inside its oldest message, so nothing between pages is skipped.
   * `after:`/`before:` are evaluated by Gmail on internal date, never the
   * sender-controlled Date header. The new watermark is the time this pass
   * STARTED (minus an overlap), so mail arriving mid-pass is read next time.
   * Re-reads are harmless: proposals dedupe per sender. If the message budget
   * runs out, the unread remainder is saved as a pending window and the pass
   * reports partial; if a window cannot be narrowed (a page of messages all in
   * one second) it fails closed instead of guessing.
   */
  const startedAt = nowSeconds;
  const queue: Window[] = [...saved.pending, { after: saved.watermark ?? nowSeconds - FIRST_RUN_LOOKBACK_SECONDS, before: null }];
  const seenIds = new Set<string>();
  const messages: SenderMessage[] = [];
  const pending: Window[] = [];
  let budget = MAX_MESSAGES_PER_PASS;
  let failure: string | null = null;

  let exhausted = false;
  for (let i = 0; i < queue.length && failure === null && !exhausted; i += 1) {
    let window = queue[i];
    while (true) {
      if (budget <= 0) {
        pending.push(window, ...queue.slice(i + 1));
        exhausted = true;
        break;
      }
      const requested = Math.min(limit, budget);
      const found = await searchGmailMessages(input.transport, {
        connectedAccountId: account.composioConnectedAccountId,
        query: buildSenderQuery(window),
        limit: requested,
        includeInternalDate: true,
        accountAlias: account.alias,
      });
      if (!found.ok) {
        failure = found.message;
        break;
      }
      budget -= found.messages.length;
      for (const m of found.messages) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        messages.push({ messageId: m.id, threadId: m.threadId, from: m.from, subject: m.subject, date: m.date });
      }
      if (found.messages.length < requested) break; // short page: window complete
      const oldest = Math.min(...found.messages.map((m) => (m.internalDateMs ?? Number.POSITIVE_INFINITY) / 1000));
      if (!Number.isFinite(oldest)) {
        failure = "Gmail did not return receipt times, so the window cannot be narrowed safely.";
        break;
      }
      // Include the oldest second again (before is exclusive): same-second neighbours are not lost.
      const before = Math.floor(oldest) + 1;
      if (window.before !== null && before >= window.before) {
        failure = "A single second holds more mail than one page; stopping instead of skipping any.";
        break;
      }
      window = { after: window.after, before };
    }
  }

  const result = await proposeContactsFromSenders(
    { workspaceId },
    {
      messages,
      // The connected mailbox's own address, so mail from the owner is never proposed.
      ownAddresses: [account.providerAccountId, account.displayName].filter((v): v is string => typeof v === "string" && v.includes("@")),
    },
  );

  const complete = failure === null && pending.length === 0;
  // Failed: the cursor is left exactly as it was (watermark and pending), state failed. Partial:
  // the watermark advances and the unread windows ride along, so pending + new always covers every second.
  const next: SenderCursor = failure === null ? { watermark: startedAt - OVERLAP_SECONDS, pending } : saved;
  await recordCursor(next, complete ? "idle" : failure ? "failed" : "partial", failure);
  await db
    .update(triggers)
    .set({ lastFiredAt: new Date(), fireCount: trigger.fireCount + 1, updatedAt: new Date() })
    .where(eq(triggers.id, trigger.id));
  if (failure) throw new Error(failure);
  return { ...result, scanned: messages.length, complete };
}

/** Every opted-in account across workspaces, one failure never stopping the rest. For the scheduler. */
export async function syncAllGmailSenders(transport: Transport, now?: Date) {
  const enabled = await db
    .select({ workspaceId: triggers.workspaceId, externalAccountId: triggers.externalAccountId })
    .from(triggers)
    .where(and(eq(triggers.provider, "gmail"), eq(triggers.eventType, SENDER_PROPOSALS_EVENT), eq(triggers.status, "enabled")));
  const summary = { accounts: 0, proposed: 0, failed: [] as Array<{ externalAccountId: string; error: string }> };
  for (const row of enabled) {
    if (!row.externalAccountId) continue;
    summary.accounts += 1;
    try {
      const result = await syncGmailSenders(row.workspaceId, { externalAccountId: row.externalAccountId, transport, now });
      summary.proposed += result.proposed.length;
    } catch (cause) {
      summary.failed.push({ externalAccountId: row.externalAccountId, error: cause instanceof Error ? cause.message : "unknown error" });
    }
  }
  return summary;
}
