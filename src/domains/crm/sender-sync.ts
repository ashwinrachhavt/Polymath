import { and, eq } from "drizzle-orm";
import { capabilityAllowed, lowestTierId } from "@/domains/integrations/capabilities";
import { externalAccounts, syncCursors, triggers } from "@/domains/integrations/schema";
import { searchGmailMessages } from "@/domains/integrations/gmail/reads";
import type { Transport } from "@/domains/integrations/transport";
import { db } from "@/lib/db";
import { proposeContactsFromSenders, type ProposeFromSendersResult } from "./propose-from-senders";

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

export type SenderSyncResult = ProposeFromSendersResult & { scanned: number; truncated: boolean };

/** Promotional and bulk categories are never people; Gmail's own classifier keeps them out of the scan. */
export function buildSenderQuery(afterEpochSeconds: number): string {
  return `in:inbox -from:me -category:promotions -category:social -category:updates -category:forums after:${afterEpochSeconds}`;
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
  const budget = trigger.budget as { perRun?: number };
  const limit = Math.max(1, Math.min(budget.perRun ?? DEFAULT_PER_RUN, MAX_PER_RUN));

  const [cursor] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, RESOURCE)))
    .limit(1);
  const after = cursor?.cursor ? Number(cursor.cursor) : nowSeconds - FIRST_RUN_LOOKBACK_SECONDS;

  const recordCursor = (values: { cursor?: string; state: "idle" | "failed"; lastError: string | null }) =>
    db
      .insert(syncCursors)
      .values({ workspaceId, externalAccountId: account.id, resource: RESOURCE, lastSyncedAt: new Date(), ...values })
      .onConflictDoUpdate({
        target: [syncCursors.externalAccountId, syncCursors.resource],
        set: { ...values, lastSyncedAt: new Date(), updatedAt: new Date() },
      });

  const found = await searchGmailMessages(input.transport, {
    connectedAccountId: account.composioConnectedAccountId,
    query: buildSenderQuery(after),
    limit,
    accountAlias: account.alias,
  });
  if (!found.ok) {
    // The watermark stays put, so the next pass re-reads the same window.
    await recordCursor({ state: "failed", lastError: found.message });
    throw new Error(found.message);
  }

  const result = await proposeContactsFromSenders(
    { workspaceId },
    {
      messages: found.messages.map((m) => ({ messageId: m.id, threadId: m.threadId, from: m.from, subject: m.subject, date: m.date })),
      // The connected mailbox's own address, so mail from the owner is never proposed.
      ownAddresses: [account.providerAccountId, account.displayName].filter((v): v is string => typeof v === "string" && v.includes("@")),
    },
  );

  // The watermark moves to now even on a full page: searchGmailMessages has no paging, so
  // hits beyond the limit cannot be fetched next time without re-reading the newest ones
  // forever. `truncated` reports that honestly instead of hiding it.
  const truncated = found.messages.length >= limit;
  const next = nowSeconds;
  await recordCursor({ cursor: String(next), state: "idle", lastError: null });
  await db
    .update(triggers)
    .set({ lastFiredAt: new Date(), fireCount: trigger.fireCount + 1, updatedAt: new Date() })
    .where(eq(triggers.id, trigger.id));
  return { ...result, scanned: found.messages.length, truncated };
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
