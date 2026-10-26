import { findFreeSlot, type Interval } from "./slots";
import { formatLocal, localDate, wallToUtc } from "./zoned";

/*
 * Calendar conflicts and the ways out of them (ASH-282). Pure: callers pass
 * the events and the working window; no clock, no database.
 *
 * Two events conflict when their times overlap. Touching end-to-start is not a
 * conflict. All-day events are context, not commitments of a time range, so
 * the caller drops them before they get here.
 *
 * Options are only offered for events Polymath owns. A synced Google event is
 * read-only from here: moving its local copy would leave Google unchanged and
 * the next sync would put it back, so the honest option for it is "resolve in
 * Google Calendar", which is advice and never a proposal.
 */

export type ConflictEvent = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  version: number;
  /** Set when the event is a time block for a task. */
  taskId: string | null;
  /** True for an event synced from a provider; Polymath cannot write it back. */
  external: boolean;
  tentative: boolean;
  attendeeCount: number;
};

export type Conflict = {
  /** Every event in the overlapping cluster, earliest first. */
  events: ConflictEvent[];
  /** Total minutes during which two or more of them are on at once. */
  overlapMinutes: number;
};

export type MoveOption = {
  kind: "move";
  eventId: string;
  eventTitle: string;
  expectedVersion: number;
  startsAt: Date;
  endsAt: Date;
  /** Signed minutes from the current start; negative is earlier. */
  shiftMinutes: number;
  /** False when other events in the cluster still overlap after this move. */
  clearsConflict: boolean;
  tradeOffs: string[];
};

export type ExternalOption = {
  kind: "resolve_in_provider";
  eventId: string;
  eventTitle: string;
  tradeOffs: string[];
};

export type ResolutionOption = MoveOption | ExternalOption;

const MIN = 60_000;
const MAX_MOVE_OPTIONS = 4;

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const span = (e: ConflictEvent): Interval => ({ start: e.startsAt, end: e.endsAt });

/** Clusters of events that overlap, directly or through a chain; singletons are not conflicts. */
export function detectConflicts(events: ConflictEvent[]): Conflict[] {
  const sorted = [...events].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime());
  const clusters: ConflictEvent[][] = [];
  let clusterEnd = 0;
  for (const e of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && e.startsAt.getTime() < clusterEnd) {
      current.push(e);
      clusterEnd = Math.max(clusterEnd, e.endsAt.getTime());
    } else {
      clusters.push([e]);
      clusterEnd = e.endsAt.getTime();
    }
  }
  return clusters.filter((c) => c.length > 1).map((c) => ({ events: c, overlapMinutes: overlapMinutes(c) }));
}

/** Minutes with at least two events active, by sweeping start and end edges. */
function overlapMinutes(cluster: ConflictEvent[]): number {
  const edges = cluster.flatMap((e) => [
    { at: e.startsAt.getTime(), delta: 1 },
    { at: e.endsAt.getTime(), delta: -1 },
  ]);
  // Ends sort before starts at the same instant so back-to-back never counts.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let last = 0;
  let total = 0;
  for (const edge of edges) {
    if (active >= 2) total += edge.at - last;
    active += edge.delta;
    last = edge.at;
  }
  return Math.round(total / MIN);
}

export type OptionContext = {
  /** Nothing earlier than this is suggested. */
  now: Date;
  /** Every event in the search window, not just the conflicting ones. */
  busy: ConflictEvent[];
  earliestMinute?: number;
  latestMinute?: number;
  bufferMinutes?: number;
  /** The owner's IANA zone; windows and day boundaries are converted per date. */
  timeZone: string;
};

function localDayStart(at: Date, timeZone: string): Date {
  return wallToUtc(timeZone, localDate(at, timeZone), 0);
}

/** "Tue, Oct 27, 10:00 AM" in the owner's zone. */
export const clock = formatLocal;

function hm(minutes: number): string {
  const m = Math.abs(minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h && rest ? `${h}h ${rest}m` : h ? `${h}h` : `${rest}m`;
}

/** Who has to say yes to moving this event, and what moving it costs. */
function costNotes(e: ConflictEvent): string[] {
  const notes: string[] = [];
  if (e.taskId) notes.push("This is a time block for a task; moving it changes only when the work happens.");
  if (e.attendeeCount > 0) {
    notes.push(`It lists ${e.attendeeCount} attendee${e.attendeeCount === 1 ? "" : "s"}; moving it here does not tell them.`);
  }
  if (e.tentative) notes.push("It is marked tentative.");
  return notes;
}

/** Cheapest to move first: task blocks, then fewer attendees, then tentative over firm. */
function moveCost(e: ConflictEvent): number {
  return (e.taskId ? 0 : 100) + e.attendeeCount * 10 + (e.tentative ? 0 : 1);
}

/** Up to two free slots for one event: the nearest later one, and the nearest earlier one that day. */
function slotsFor(event: ConflictEvent, ctx: OptionContext): Interval[] {
  const minutes = Math.round((event.endsAt.getTime() - event.startsAt.getTime()) / MIN);
  const others = ctx.busy.filter((b) => b.id !== event.id).map(span);
  const search = (from: Date) =>
    findFreeSlot({
      from,
      minutes,
      busy: others,
      earliestMinute: ctx.earliestMinute,
      latestMinute: ctx.latestMinute,
      bufferMinutes: ctx.bufferMinutes,
      timeZone: ctx.timeZone,
    });

  const found: Interval[] = [];
  const later = search(new Date(Math.max(event.startsAt.getTime(), ctx.now.getTime())));
  if (later && later.start.getTime() !== event.startsAt.getTime()) found.push(later);

  const dayFrom = new Date(Math.max(localDayStart(event.startsAt, ctx.timeZone).getTime(), ctx.now.getTime()));
  const earlier = search(dayFrom);
  if (earlier && earlier.end.getTime() <= event.startsAt.getTime()) found.push(earlier);
  return found;
}

/**
 * Ranked ways to resolve one conflict. Moves are only for events Polymath
 * owns, and each one is checked against the whole calendar so it lands in
 * free time. At most one event per option moves; a cluster of three may need a
 * second pass once the first change is approved, and an option says so.
 */
export function resolutionOptions(conflict: Conflict, ctx: OptionContext): ResolutionOption[] {
  const movable = conflict.events.filter((e) => !e.external).sort((a, b) => moveCost(a) - moveCost(b));
  const moves: MoveOption[] = [];
  for (const event of movable) {
    for (const slot of slotsFor(event, ctx)) {
      const moved = { ...event, startsAt: slot.start, endsAt: slot.end };
      const rest = conflict.events.map((e) => (e.id === event.id ? moved : e));
      const clearsConflict = detectConflicts(rest).length === 0;
      const shiftMinutes = Math.round((slot.start.getTime() - event.startsAt.getTime()) / MIN);
      const sameDay = localDayStart(slot.start, ctx.timeZone).getTime() === localDayStart(event.startsAt, ctx.timeZone).getTime();
      moves.push({
        kind: "move",
        eventId: event.id,
        eventTitle: event.title,
        expectedVersion: event.version,
        startsAt: slot.start,
        endsAt: slot.end,
        shiftMinutes,
        clearsConflict,
        tradeOffs: [
          `Moves "${event.title}" ${hm(shiftMinutes)} ${shiftMinutes < 0 ? "earlier" : "later"} to ${clock(slot.start, ctx.timeZone)}${sameDay ? ", the same day" : ""}.`,
          ...costNotes(event),
          ...(clearsConflict ? [] : ["Other events in this cluster still overlap afterwards; check again once this is approved."]),
        ],
      });
    }
  }
  moves.sort((a, b) => Number(b.clearsConflict) - Number(a.clearsConflict) || moveRank(a, conflict) - moveRank(b, conflict) || Math.abs(a.shiftMinutes) - Math.abs(b.shiftMinutes));

  const options: ResolutionOption[] = moves.slice(0, MAX_MOVE_OPTIONS);
  for (const event of conflict.events.filter((e) => e.external)) {
    options.push({
      kind: "resolve_in_provider",
      eventId: event.id,
      eventTitle: event.title,
      tradeOffs: [
        `"${event.title}" comes from a synced calendar and Polymath cannot change it.`,
        "Decline or reschedule it in Google Calendar, then sync again; nothing is proposed for it here.",
      ],
    });
  }
  return options;
}

function moveRank(option: MoveOption, conflict: Conflict): number {
  const event = conflict.events.find((e) => e.id === option.eventId);
  return event ? moveCost(event) : Number.MAX_SAFE_INTEGER;
}

/**
 * True when `slot` is still a legal home for the event right now: it keeps the
 * event's length, starts in the future, and overlaps nothing else. Run at
 * propose time so an option read minutes ago is not trusted blindly.
 */
export function slotIsFree(event: ConflictEvent, slot: Interval, busy: ConflictEvent[], now: Date): boolean {
  const length = event.endsAt.getTime() - event.startsAt.getTime();
  if (slot.end.getTime() - slot.start.getTime() !== length) return false;
  if (slot.start.getTime() < now.getTime()) return false;
  return !busy.some((b) => b.id !== event.id && overlaps(slot, span(b)));
}
