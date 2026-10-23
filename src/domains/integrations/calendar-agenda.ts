import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { externalAccounts } from "@/domains/integrations/schema";
import { composioGoogleCalendarClient, type GoogleCalendarClient } from "@/integrations/google-calendar/client";
import { db } from "@/lib/db";
import type { GoogleEvent } from "@/domains/calendar/google-mapper";

/*
 * Today's agenda for the Briefing (spec: the briefing knows the calendar or
 * plainly says it cannot). Read-only against Google through the same Composio
 * client the sync uses; nothing is written anywhere - not to Google, not to
 * the local event store.
 *
 * Every non-event outcome is a named state, never a silent empty list:
 *  - not_connected: no active Google Calendar account in the workspace.
 *  - unconfigured:  an account row exists but has no Composio connection.
 *  - unavailable:   the provider or deployment failed, or the read was
 *                   truncated; the reason is named.
 *  - ok with []:    nothing today on this account's primary calendar - only
 *                   ever reported after a successful, complete read, so
 *                   "nothing today" can never mask a failure. The read covers
 *                   the primary calendar only; it cannot vouch for other
 *                   calendars the account can see.
 * One result per active account: one account's failure never hides
 * another's events, and the panel can name which calendar failed.
 */

export type AgendaEvent = {
  id: string;
  title: string;
  /** RFC3339 instant for timed events, YYYY-MM-DD for all-day ones. */
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
};

export type AgendaAccount =
  /** `calendar: "primary"` - the read cannot vouch for the account's other calendars. */
  | { status: "ok"; alias: string; calendar: "primary"; events: AgendaEvent[] }
  | { status: "unconfigured"; alias: string }
  | { status: "unavailable"; alias: string; reason: string };

export type TodayAgenda =
  | { status: "not_connected" }
  | { status: "connected"; day: string; timezone: string; asOf: string; accounts: AgendaAccount[] };

export function toAgendaEvent(event: GoogleEvent): AgendaEvent | null {
  if (event.status === "cancelled") return null;
  const startsAt = event.start?.dateTime ?? event.start?.date;
  if (!startsAt) return null;
  // Events overlapping the window come back from Google with their real
  // start/end, which may sit outside today (an event that began yesterday, a
  // multi-day all-day event); they pass through unchanged so the panel can
  // render them as continuing.
  return {
    id: event.id,
    title: event.summary?.trim() || "(untitled event)",
    startsAt,
    endsAt: event.end?.dateTime ?? event.end?.date ?? null,
    allDay: !event.start?.dateTime,
    location: event.location ?? null,
  };
}

/** The UTC instant of local midnight at the start of `day` (YYYY-MM-DD) in `tz`. */
function localMidnightUtc(day: string, tz: string): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const targetMs = Date.parse(`${day}T00:00:00Z`);
  let utc = new Date(targetMs);
  // Iterate the offset correction: DST makes it a function of the answer.
  for (let i = 0; i < 3; i += 1) {
    const localMs = Date.parse(`${fmt.format(utc).replace(", ", "T")}Z`);
    const diff = localMs - targetMs;
    if (diff === 0) break;
    utc = new Date(utc.getTime() - diff);
  }
  return utc;
}

/** [start, end) of the workspace-local day containing `now`, as RFC3339 instants. */
export function workspaceDayWindow(tz: string, now: Date): { timeMin: string; timeMax: string; day: string } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = localMidnightUtc(day, tz);
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const end = localMidnightUtc(nextDay, tz);
  return { timeMin: start.toISOString(), timeMax: end.toISOString(), day };
}

async function workspaceTimezone(auth: AuthContext): Promise<string> {
  const rows = await db.execute(sql`
    select coalesce(
      (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}),
      'UTC'
    ) as tz
  `);
  return ((rows as unknown as Array<{ tz: string }>)[0]?.tz || "UTC") as string;
}

/**
 * Reasons shown to the user are whitelist-sanitized: raw provider and network
 * errors can carry URLs, tokens, or payloads, so only our own known-safe
 * message shapes pass through; anything else degrades to a plain statement.
 */
export function sanitizedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("COMPOSIO_API_KEY")) return "Calendar sync is not configured on this deployment yet.";
  const http = /^Google Calendar read failed \(HTTP (\d{3})\)\.$/.exec(message);
  if (http) return `Google Calendar could not be read (HTTP ${http[1]}).`;
  if (message === "Google Calendar returned an unexpected response.") return message;
  return "Google Calendar could not be read.";
}

export async function getTodayAgenda(
  auth: AuthContext,
  opts: { now?: Date; clientFor?: (connectedAccountId: string) => GoogleCalendarClient } = {},
): Promise<TodayAgenda> {
  const now = opts.now ?? new Date();
  const accounts = await db
    .select({ alias: externalAccounts.alias, composioConnectedAccountId: externalAccounts.composioConnectedAccountId })
    .from(externalAccounts)
    .where(and(
      eq(externalAccounts.workspaceId, auth.workspaceId),
      eq(externalAccounts.provider, "google-calendar"),
      eq(externalAccounts.status, "active"),
    ));
  if (accounts.length === 0) return { status: "not_connected" };

  const tz = await workspaceTimezone(auth);
  const { timeMin, timeMax, day } = workspaceDayWindow(tz, now);
  const clientFor = opts.clientFor ?? composioGoogleCalendarClient;

  const results: AgendaAccount[] = [];
  for (const account of accounts) {
    if (!account.composioConnectedAccountId) {
      results.push({ status: "unconfigured", alias: account.alias });
      continue;
    }
    try {
      const { events, truncated } = await clientFor(account.composioConnectedAccountId).listEventsUpdatedSince(null, { timeMin, timeMax });
      if (truncated) {
        results.push({ status: "unavailable", alias: account.alias, reason: "This calendar has more events today than can be shown." });
        continue;
      }
      const agenda = events
        .map(toAgendaEvent)
        .filter((e): e is AgendaEvent => e !== null)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      results.push({ status: "ok", alias: account.alias, calendar: "primary", events: agenda });
    } catch (error) {
      results.push({ status: "unavailable", alias: account.alias, reason: sanitizedReason(error) });
    }
  }
  return { status: "connected", day, timezone: tz, asOf: now.toISOString(), accounts: results };
}
