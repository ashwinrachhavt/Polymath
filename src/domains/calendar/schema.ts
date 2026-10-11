import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutable, primaryId, recorded, tenantId } from "../../db/columns";

/*
 * Local plans and provider events keep distinct identities. A provider event
 * carries (external_account_id, provider_object_id) plus the provider's own
 * etag, so an update is a conditional write rather than a last-write-wins
 * guess; an event with no external account is local and never pushed anywhere
 * without a proposal.
 */

export const calendarKind = pgEnum("calendar_kind", ["local", "external"]);
export const eventStatus = pgEnum("event_status", ["confirmed", "tentative", "cancelled"]);
export const attendeeResponse = pgEnum("attendee_response", [
  "needs_action",
  "accepted",
  "declined",
  "tentative",
]);
export const scheduleProposalStatus = pgEnum("schedule_proposal_status", [
  "proposed",
  "applied",
  "rejected",
  "expired",
]);

export const calendars = pgTable(
  "calendars",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    kind: calendarKind("kind").notNull().default("local"),
    name: text("name").notNull(),
    color: text("color"),
    timezone: text("timezone"),
    /** Null for local calendars; set once a provider backs it. */
    externalAccountId: uuid("external_account_id"),
    providerObjectId: text("provider_object_id"),
    isPrimary: boolean("is_primary").notNull().default(false),
    syncEnabled: boolean("sync_enabled").notNull().default(false),
    ...mutable,
  },
  (t) => [
    uniqueIndex("calendars_workspace_name_key").on(t.workspaceId, t.name),
    uniqueIndex("calendars_external_key")
      .on(t.externalAccountId, t.providerObjectId)
      .where(sql`provider_object_id is not null`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    timezone: text("timezone"),
    status: eventStatus("status").notNull().default("confirmed"),
    externalAccountId: uuid("external_account_id"),
    providerObjectId: text("provider_object_id"),
    /** Provider version/etag, kept so updates can be conditional. */
    providerEtag: text("provider_etag"),
    recurrenceRule: text("recurrence_rule"),
    ...mutable,
  },
  (t) => [
    index("events_calendar_range_idx").on(t.calendarId, t.startsAt, t.endsAt),
    index("events_workspace_range_idx").on(t.workspaceId, t.startsAt),
    uniqueIndex("events_external_key")
      .on(t.externalAccountId, t.providerObjectId)
      .where(sql`provider_object_id is not null`),
  ],
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    email: text("email"),
    displayName: text("display_name"),
    /** Set when the attendee is a known contact; correspondence stays optional. */
    contactId: uuid("contact_id"),
    response: attendeeResponse("response").notNull().default("needs_action"),
    organizer: boolean("organizer").notNull().default(false),
    ...recorded,
  },
  (t) => [
    index("event_attendees_event_idx").on(t.eventId),
    uniqueIndex("event_attendees_event_email_key")
      .on(t.eventId, t.email)
      .where(sql`email is not null`),
  ],
);

export const eventLinks = pgTable(
  "event_links",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    label: text("label"),
    ...recorded,
  },
  (t) => [
    uniqueIndex("event_links_edge_key").on(t.eventId, t.targetType, t.targetId),
    index("event_links_target_idx").on(t.workspaceId, t.targetType, t.targetId),
  ],
);

export const schedulerPreferences = pgTable(
  "scheduler_preferences",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Working windows: [{ weekday, startMinute, endMinute }]. */
    workingHours: jsonb("working_hours").notNull().default([]),
    defaultMeetingMinutes: integer("default_meeting_minutes").notNull().default(30),
    /** Minutes of buffer kept around a meeting when suggesting a slot. */
    bufferMinutes: integer("buffer_minutes").notNull().default(10),
    earliestMinute: integer("earliest_minute").notNull().default(9 * 60),
    latestMinute: integer("latest_minute").notNull().default(18 * 60),
    ...mutable,
  },
  (t) => [uniqueIndex("scheduler_preferences_workspace_key").on(t.workspaceId)],
);

/*
 * A proposed schedule change: previewable, expirable, and never applied to a
 * provider without going through Reviews. The scheduler proposes; it does not
 * silently rewrite time.
 */
export const scheduleProposals = pgTable(
  "schedule_proposals",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    proposedStartAt: timestamp("proposed_start_at", { withTimezone: true }).notNull(),
    proposedEndAt: timestamp("proposed_end_at", { withTimezone: true }).notNull(),
    /** Why this slot: conflicts, buffers, and deadline pressure, stated plainly. */
    rationale: text("rationale"),
    conflicts: jsonb("conflicts").notNull().default([]),
    status: scheduleProposalStatus("status").notNull().default("proposed"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...mutable,
  },
  (t) => [index("schedule_proposals_pending_idx").on(t.workspaceId, t.status, t.proposedStartAt)],
);
