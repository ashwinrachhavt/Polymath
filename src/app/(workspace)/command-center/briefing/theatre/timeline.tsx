"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { WeekEvent } from "@/domains/calendar/queries";
import type { FocusSessionView } from "@/domains/focus/queries";
import { scheduleCaptureAction, startScheduledSessionAction, unscheduleSessionAction } from "./actions";
import { EventBlock } from "./event-blocks";
import { modelOf, SessionBlock } from "./session-blocks";
import { useDayPoll } from "./use-day-poll";

/*
 * The theatre timeline (ASH-308): one vertical hour grid for the local day,
 * the now-line at wall-clock position, sessions and events as blocks, and
 * hour slots as drop targets for capture chips. A drop onto a past slot is a
 * no-op with the slot visually refusing - never an error toast.
 *
 * Polling keeps it living: useDayPoll refreshes the server projection every
 * 30 s while the tab is visible; a failed refresh keeps this render and
 * moves the "as of" marker instead of clearing the day.
 */

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MIN_PX = 1; // 60px per hour: a quiet day is one calm column.


export function TheatreTimeline({
  dayStart,
  sessions,
  events,
  sessionError,
  eventError,
}: {
  dayStart: string;
  sessions: FocusSessionView[];
  events: WeekEvent[];
  sessionError?: string;
  eventError?: string;
}) {
  const router = useRouter();
  const { asOf, stale } = useDayPoll();
  const dayStartMs = new Date(dayStart).getTime();
  const [now, setNow] = useState(() => Date.now());
  const [refusingSlot, setRefusingSlot] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const nowMinutes = (now - dayStartMs) / 60_000;
  const models = sessions
    .map((session) => modelOf(session, dayStartMs, now))
    .filter((model) => model !== null);

  const drop = async (event: React.DragEvent, hour: number) => {
    event.preventDefault();
    const captureId = event.dataTransfer.getData("application/x-capture-id");
    if (!captureId) return;
    const slot = new Date(dayStartMs + hour * 3_600_000);
    if (slot.getTime() <= now) {
      // A past slot refuses visually; no toast, no request.
      setRefusingSlot(hour);
      window.setTimeout(() => setRefusingSlot(null), 900);
      return;
    }
    const result = await scheduleCaptureAction({
      captureId,
      scheduledAt: slot.toISOString(),
      idempotencyKey: crypto.randomUUID(),
    });
    if (result.ok) router.refresh();
  };

  return (
    <div className="relative" data-testid="theatre-timeline">
      <p className="mb-2 text-[11px] text-muted-foreground" role="status">
        {stale ? `As of ${asOf ? asOf.toTimeString().slice(0, 5) : "before"} - reconnecting` : asOf ? `Live as of ${asOf.toTimeString().slice(0, 5)}` : "Live"}
      </p>
      <div className="relative border-t border-border" style={{ height: 24 * 60 * MIN_PX }}>
        {HOURS.map((hour) => (
          <div
            key={hour}
            className={`relative border-b border-border/60 ${refusingSlot === hour ? "bg-destructive/10" : ""}`}
            style={{ height: 60 * MIN_PX }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("application/x-capture-id")) event.preventDefault();
            }}
            onDrop={(event) => void drop(event, hour)}
            data-testid={`slot-${hour}`}
          >
            <span className="absolute top-0 left-1 w-10 text-[10px] text-muted-foreground">{String(hour).padStart(2, "0")}:00</span>
          </div>
        ))}
        {nowMinutes >= 0 && nowMinutes <= 24 * 60 ? (
          <div className="pointer-events-none absolute right-0 left-0 z-10 border-t-2 border-app-accent" style={{ top: nowMinutes * MIN_PX }} data-testid="now-line">
            <span className="absolute -top-2 left-11 rounded-sm bg-app-accent px-1 text-[10px] font-medium text-app-accent-foreground">now</span>
          </div>
        ) : null}
        {sessionError ? (
          <div className="absolute top-2 right-2 left-14 rounded-md border border-dashed border-border bg-muted/30 p-3 text-[12px]" role="alert">
            Focus sessions unavailable - {sessionError}
          </div>
        ) : (
          models.map((model) => (
            <SessionBlock
              key={model.id}
              model={model}
              onStart={(id, version) => {
                void startScheduledSessionAction({ sessionId: id, expectedVersion: version }).then((result) => {
                  if (result.ok) router.refresh();
                });
              }}
              onDismiss={(id) => {
                void unscheduleSessionAction({ sessionId: id }).then((result) => {
                  if (result.ok) router.refresh();
                });
              }}
            />
          ))
        )}
        {eventError ? (
          <div className="absolute right-2 bottom-2 left-14 rounded-md border border-dashed border-border bg-muted/30 p-3 text-[12px]" role="alert">
            Calendar unavailable - {eventError}
          </div>
        ) : (
          events.map((event) => (
            <EventBlock
              key={event.id}
              event={{ ...event, startsAt: new Date(event.startsAt), endsAt: new Date(event.endsAt) }}
              dayStartMs={dayStartMs}
              nowMs={now}
            />
          ))
        )}
      </div>
    </div>
  );
}
