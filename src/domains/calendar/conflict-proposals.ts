import { loadConflictWindow, type ProviderFreshness } from "./conflict-queries";
import {
  clock,
  detectConflicts,
  resolutionOptions,
  slotIsFree,
  type ConflictEvent,
  type ResolutionOption,
} from "./conflicts";
import { proposeCalendarChange } from "./proposals";

/*
 * The agent-facing half of conflict resolution (ASH-282). Reading is free;
 * writing is a proposal. Nothing here changes the calendar: a chosen option
 * becomes a "move" proposal the owner approves in the review queue, and the
 * approved revision then executes through the same command a person uses.
 *
 * The agent never supplies a time of its own. A proposal must name one of the
 * slots this module offers, and the slot is re-checked against the calendar as
 * it is right now, so an option read a few minutes ago cannot book a
 * collision. The same goes for the event: only a Polymath-owned event at the
 * version the agent saw can be proposed for a move.
 */

const DEFAULT_DAYS = 14;
const MAX_DAYS = 30;
const DAY = 86_400_000;

type Auth = { workspaceId: string; userId: string };

export type ConflictReport = {
  windowStart: string;
  windowEnd: string;
  timezone: string;
  conflicts: Array<{
    overlapMinutes: number;
    events: Array<{ id: string; title: string; startsAt: string; endsAt: string; version: number; source: "polymath" | "google"; tentative: boolean }>;
    options: Array<
      | { kind: "move"; eventId: string; expectedVersion: number; startsAt: string; endsAt: string; clearsConflict: boolean; tradeOffs: string[] }
      | { kind: "resolve_in_provider"; eventId: string; tradeOffs: string[] }
    >;
  }>;
  /** Plain statements about what was and was not checked. */
  notices: string[];
};

function providerNotices(providers: ProviderFreshness[]): string[] {
  if (providers.length === 0) {
    return ["No Google Calendar is connected, so only events in Polymath were checked."];
  }
  return providers.flatMap((p) => {
    if (p.status !== "active") return [`Google Calendar "${p.alias}" is ${p.status}, so its events may be missing or out of date.`];
    if (!p.lastSyncedAt) return [`Google Calendar "${p.alias}" has not synced yet, so its events are not included.`];
    return [`Google Calendar "${p.alias}" last synced ${p.lastSyncedAt.toISOString()}; later changes in Google are not reflected.`];
  });
}

function serializeOption(option: ResolutionOption): ConflictReport["conflicts"][number]["options"][number] {
  if (option.kind === "resolve_in_provider") {
    return { kind: option.kind, eventId: option.eventId, tradeOffs: option.tradeOffs };
  }
  return {
    kind: option.kind,
    eventId: option.eventId,
    expectedVersion: option.expectedVersion,
    startsAt: option.startsAt.toISOString(),
    endsAt: option.endsAt.toISOString(),
    clearsConflict: option.clearsConflict,
    tradeOffs: option.tradeOffs,
  };
}

/** Conflicts in the next `days` days, each with ranked options and their trade-offs. */
export async function listCalendarConflicts(auth: Auth, input: { now?: Date; days?: number } = {}): Promise<ConflictReport> {
  const now = input.now ?? new Date();
  const days = Math.min(Math.max(input.days ?? DEFAULT_DAYS, 1), MAX_DAYS);
  const to = new Date(now.getTime() + days * DAY);
  const window = await loadConflictWindow(auth, now, to);

  const conflicts = detectConflicts(window.events).map((conflict) => ({
    overlapMinutes: conflict.overlapMinutes,
    events: conflict.events.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      version: e.version,
      source: e.external ? ("google" as const) : ("polymath" as const),
      tentative: e.tentative,
    })),
    options: resolutionOptions(conflict, {
      now,
      busy: window.events,
      earliestMinute: window.earliestMinute,
      latestMinute: window.latestMinute,
      bufferMinutes: window.bufferMinutes,
      timeZone: window.timezone,
    }).map(serializeOption),
  }));

  return {
    windowStart: now.toISOString(),
    windowEnd: to.toISOString(),
    timezone: window.timezone,
    conflicts,
    notices: providerNotices(window.providers),
  };
}

export type ProposeMoveResult =
  | { ok: true; proposalId: string; deduplicated: boolean }
  | { ok: false; code: "event_not_found" | "event_is_external" | "event_changed" | "slot_unavailable"; message: string };

/** Turns one offered option into a move proposal for the owner to approve. */
export async function proposeConflictMove(
  auth: Auth,
  input: { eventId: string; expectedVersion: number; startsAt: Date; endsAt: Date; runId: string; now?: Date },
): Promise<ProposeMoveResult> {
  const now = input.now ?? new Date();
  const window = await loadConflictWindow(auth, now, new Date(Math.max(input.endsAt.getTime(), now.getTime()) + DAY));
  const event: ConflictEvent | undefined = window.events.find((e) => e.id === input.eventId);
  if (!event) {
    return { ok: false, code: "event_not_found", message: "That event is not on the calendar any more. Read the conflicts again." };
  }
  if (event.external) {
    return {
      ok: false,
      code: "event_is_external",
      message: "That event comes from Google Calendar and Polymath cannot change it. Ask the owner to decline or reschedule it there.",
    };
  }
  if (event.version !== input.expectedVersion) {
    return { ok: false, code: "event_changed", message: "That event changed since it was read. Read the conflicts again." };
  }
  if (!slotIsFree(event, { start: input.startsAt, end: input.endsAt }, window.events, now)) {
    return { ok: false, code: "slot_unavailable", message: "That time is no longer free or no longer fits the event. Read the conflicts again." };
  }

  const at = (d: Date) => clock(d, window.timezone);
  const clashing = window.events
    .filter((e) => e.id !== event.id && e.startsAt < event.endsAt && event.startsAt < e.endsAt)
    .map((e) => `"${e.title}"`);
  const note =
    `Moves "${event.title}" from ${at(event.startsAt)} to ${at(input.startsAt)} (${window.timezone})` +
    (clashing.length ? `, clearing its overlap with ${clashing.join(", ")}.` : ".");

  const result = await proposeCalendarChange(auth, {
    change: {
      kind: "move",
      eventId: event.id,
      expectedVersion: event.version,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      title: event.title,
      note,
    },
    dedupeKey: `${input.runId}:conflict:${event.id}:${event.version}:${input.startsAt.toISOString()}`,
    runId: input.runId,
  });
  return { ok: true, ...result };
}
