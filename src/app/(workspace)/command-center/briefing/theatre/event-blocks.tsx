import type { WeekEvent } from "@/domains/calendar/queries";

/*
 * One calendar event on the timeline (ASH-308). Calendar is read-only here:
 * the block renders the commitment, nothing on it mutates anything.
 */
export function EventBlock({ event, dayStartMs, nowMs }: { event: WeekEvent; dayStartMs: number; nowMs: number }) {
  const MIN = 60_000;
  const top = Math.max(0, (event.startsAt.getTime() - dayStartMs) / MIN);
  const height = Math.max(20, (event.endsAt.getTime() - event.startsAt.getTime()) / MIN);
  const live = event.startsAt.getTime() <= nowMs && nowMs < event.endsAt.getTime();
  return (
    <div
      className={`absolute right-2 left-14 overflow-hidden rounded-md border px-2 py-1 ${live ? "border-blue-500/60 bg-blue-500/10" : "border-border bg-muted/40"}`}
      style={{ top, minHeight: height }}
      data-testid={`event-${event.id}`}
    >
      <p className="truncate text-[12px] font-medium">{event.title}</p>
      <p className="text-[11px] text-muted-foreground">
        {event.startsAt.toISOString().slice(11, 16)} - {event.endsAt.toISOString().slice(11, 16)}
        {live ? " · now" : ""}
      </p>
    </div>
  );
}
