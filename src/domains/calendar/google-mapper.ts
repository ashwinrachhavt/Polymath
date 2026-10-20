/*
 * Google Calendar -> Polymath mapping for the Composio sync (ASH-185). Pure:
 * it never calls Composio. A later fetcher passes the provider's event JSON
 * in, and `planSync` says which local rows to create, update or cancel.
 * Provider identity is (externalAccountId, providerObjectId); the etag decides
 * whether a row changed, so an unchanged re-sync writes nothing.
 */

export type GoogleEvent = {
  id: string;
  etag?: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
};

export type MappedEvent = {
  providerObjectId: string;
  providerEtag: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurrenceRule: string | null;
};

const DAY = 86_400_000;

/** Null when the event has no usable time range (it is skipped, not guessed). */
export function mapGoogleEvent(event: GoogleEvent): MappedEvent | null {
  if (!event.id) return null;
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  let startsAt: Date;
  let endsAt: Date;
  if (allDay) {
    startsAt = new Date(`${event.start!.date}T00:00:00Z`);
    // Google's all-day end date is exclusive; a missing end means one day.
    endsAt = event.end?.date ? new Date(`${event.end.date}T00:00:00Z`) : new Date(startsAt.getTime() + DAY);
  } else {
    if (!event.start?.dateTime || !event.end?.dateTime) return null;
    startsAt = new Date(event.start.dateTime);
    endsAt = new Date(event.end.dateTime);
  }
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return null;
  return {
    providerObjectId: event.id,
    providerEtag: event.etag ?? null,
    title: event.summary?.trim() || "(no title)",
    description: event.description ?? null,
    location: event.location ?? null,
    startsAt,
    endsAt,
    allDay,
    timezone: event.start?.timeZone ?? null,
    status: event.status ?? "confirmed",
    recurrenceRule: event.recurrence?.find((r) => r.startsWith("RRULE:")) ?? null,
  };
}

export type ExistingRow = { providerObjectId: string; providerEtag: string | null; status: string; id: string };

export type SyncPlan = {
  create: MappedEvent[];
  update: Array<{ id: string; event: MappedEvent }>;
  cancel: Array<{ id: string }>;
  unchanged: number;
  skipped: number;
};

export function planSync(existing: ExistingRow[], incoming: GoogleEvent[]): SyncPlan {
  const byProviderId = new Map(existing.map((r) => [r.providerObjectId, r]));
  const plan: SyncPlan = { create: [], update: [], cancel: [], unchanged: 0, skipped: 0 };
  for (const raw of incoming) {
    const row = byProviderId.get(raw.id);
    // A deleted event arrives as status "cancelled" with no times.
    if (raw.status === "cancelled") {
      if (row && row.status !== "cancelled") plan.cancel.push({ id: row.id });
      else plan.unchanged += 1;
      continue;
    }
    const mapped = mapGoogleEvent(raw);
    if (!mapped) {
      plan.skipped += 1;
      continue;
    }
    if (!row) plan.create.push(mapped);
    else if (mapped.providerEtag && mapped.providerEtag === row.providerEtag && row.status !== "cancelled") plan.unchanged += 1;
    else plan.update.push({ id: row.id, event: mapped });
  }
  return plan;
}
