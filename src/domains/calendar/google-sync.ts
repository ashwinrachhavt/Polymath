import { and, eq, isNotNull } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { externalAccounts, syncCursors } from "@/domains/integrations/schema";
import { composioGoogleCalendarClient, type GoogleCalendarClient } from "@/integrations/google-calendar/client";
import { withTransaction } from "@/lib/db-transaction";
import { planSync } from "./google-mapper";
import { calendars, events } from "./schema";

/*
 * One sync pass over a connected Google Calendar account (ASH-185). Read-only
 * against Google. Events land in the same calendars/events tables as local
 * ones, on an "external" calendar named for the account alias, so the week
 * view and agents read one store. The watermark is Google's `updated` stamp.
 * Local blocks are never pushed out: nothing is written to Google from here.
 */

const RESOURCE = "events";
const DAY = 86_400_000;

export class GoogleSyncError extends Error {
  constructor(readonly code: "account_not_found" | "no_connection", message: string) {
    super(message);
  }
}

export type GoogleSyncResult = { created: number; updated: number; cancelled: number; unchanged: number; skipped: number };

export async function syncGoogleCalendarAccount(
  auth: AuthContext,
  input: { externalAccountId: string; client?: GoogleCalendarClient; now?: Date },
): Promise<GoogleSyncResult> {
  const now = input.now ?? new Date();
  return withTransaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.id, input.externalAccountId), eq(externalAccounts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!account || account.provider !== "google-calendar") {
      throw new GoogleSyncError("account_not_found", "No Google Calendar account with that id in this workspace.");
    }
    if (!account.composioConnectedAccountId && !input.client) {
      throw new GoogleSyncError("no_connection", "This Google Calendar account has no Composio connection yet.");
    }
    const client = input.client ?? composioGoogleCalendarClient(account.composioConnectedAccountId!);

    const [cursor] = await tx
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, RESOURCE)))
      .limit(1);

    const [calendarRow] = await tx
      .insert(calendars)
      .values({
        workspaceId: auth.workspaceId,
        kind: "external",
        name: `Google (${account.alias})`,
        externalAccountId: account.id,
        providerObjectId: "primary",
        syncEnabled: true,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [calendars.workspaceId, calendars.name],
        set: { syncEnabled: true },
      })
      .returning({ id: calendars.id });

    const existing = await tx
      .select({ id: events.id, providerObjectId: events.providerObjectId, providerEtag: events.providerEtag, status: events.status })
      .from(events)
      .where(and(eq(events.externalAccountId, account.id), isNotNull(events.providerObjectId)));
    const { events: incoming, newestUpdated } = await client.listEventsUpdatedSince(cursor?.cursor ?? null, {
      timeMin: new Date(now.getTime() - 30 * DAY).toISOString(),
      timeMax: new Date(now.getTime() + 180 * DAY).toISOString(),
    });
    const plan = planSync(
      existing.map((r) => ({ id: r.id, providerObjectId: r.providerObjectId!, providerEtag: r.providerEtag, status: r.status })),
      incoming,
    );

    const fields = (e: (typeof plan.create)[number]) => ({
      title: e.title,
      description: e.description,
      location: e.location,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      allDay: e.allDay,
      timezone: e.timezone,
      status: e.status,
      providerEtag: e.providerEtag,
      recurrenceRule: e.recurrenceRule,
    });
    for (const e of plan.create) {
      await tx
        .insert(events)
        .values({
          workspaceId: auth.workspaceId,
          calendarId: calendarRow.id,
          externalAccountId: account.id,
          providerObjectId: e.providerObjectId,
          ...fields(e),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing();
    }
    for (const u of plan.update) {
      await tx.update(events).set({ ...fields(u.event), updatedBy: auth.userId }).where(eq(events.id, u.id));
    }
    for (const c of plan.cancel) {
      await tx.update(events).set({ status: "cancelled", updatedBy: auth.userId }).where(eq(events.id, c.id));
    }

    const watermark = newestUpdated ?? cursor?.cursor ?? null;
    if (cursor) {
      await tx
        .update(syncCursors)
        .set({ cursor: watermark, state: "idle", lastSyncedAt: now, lastError: null, updatedAt: now, updatedBy: auth.userId })
        .where(eq(syncCursors.id, cursor.id));
    } else {
      await tx.insert(syncCursors).values({
        workspaceId: auth.workspaceId,
        externalAccountId: account.id,
        resource: RESOURCE,
        cursor: watermark,
        state: "idle",
        lastSyncedAt: now,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
    }
    await recordAudit(
      auth,
      {
        action: "integration.google_calendar_synced",
        subjectType: "external_account",
        subjectId: account.id,
        summary: `Google Calendar sync: ${plan.create.length} new, ${plan.update.length} updated, ${plan.cancel.length} cancelled`,
      },
      tx,
    );
    return {
      created: plan.create.length,
      updated: plan.update.length,
      cancelled: plan.cancel.length,
      unchanged: plan.unchanged,
      skipped: plan.skipped,
    };
  });
}
