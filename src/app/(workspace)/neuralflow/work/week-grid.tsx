"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { blockTimeAction, cancelEventAction } from "./calendar-actions";

/*
 * Weekly time grid. Receives ISO instants and renders them in the browser's
 * local time, so blocks land where the owner expects whatever the server's
 * zone is. Time blocks come from the calendar domain; due tasks without a
 * block are listed beside the grid with a "Block time" button that asks the
 * server for the first free working-hours slot.
 */

export type GridEvent = { id: string; title: string; startsAt: string; endsAt: string; version: number; taskId: string | null };
export type GridTask = { id: string; title: string; estimateMinutes: number | null; done: boolean };

const START_HOUR = 7;
const END_HOUR = 21;
const HOUR_PX = 44;

function minutesOfDay(d: Date) {
  return d.getHours() * 60 + d.getMinutes();
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Pinned locale: this component renders during SSR too, and an undefined
// locale makes the server's locale race the browser's (hydration mismatch).
const LOCALE = "en-US";

export function WeekGrid({
  weekStartMs,
  events,
  unscheduled,
}: {
  weekStartMs: number;
  events: GridEvent[];
  unscheduled: GridTask[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  // Local midnight for each of the seven days, derived on the client.
  const first = new Date(weekStartMs);
  const days = Array.from({ length: 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const now = new Date();

  function block(task: GridTask) {
    setMessage(null);
    startTransition(async () => {
      const result = await blockTimeAction({
        taskId: task.id,
        minutes: task.estimateMinutes ?? undefined,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(result.ok ? `Blocked time for "${task.title}".` : result.error);
    });
  }

  function remove(event: GridEvent) {
    setMessage(null);
    startTransition(async () => {
      const result = await cancelEventAction({ eventId: event.id, expectedVersion: event.version, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) setMessage(result.error);
    });
  }

  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div className="grid min-w-[640px]" style={{ gridTemplateColumns: "44px repeat(7, minmax(0, 1fr))" }}>
          <div />
          {days.map((day) => (
            <div key={day.toISOString()} className="border-b border-border px-1 pb-1.5 text-center text-xs">
              <span className="text-muted-foreground">{day.toLocaleDateString(LOCALE, { weekday: "short" })}</span>{" "}
              <span className={sameDay(day, now) ? "rounded-full bg-foreground px-1.5 py-0.5 text-background" : "font-medium"}>
                {day.getDate()}
              </span>
            </div>
          ))}
          <div className="relative" style={{ height: hours.length * HOUR_PX }}>
            {hours.map((h, i) => (
              <span key={h} className="absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground" style={{ top: i * HOUR_PX }}>
                {new Date(2000, 0, 1, h).toLocaleTimeString(LOCALE, { hour: "numeric" })}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const dayEvents = events.filter((e) => sameDay(new Date(e.startsAt), day));
            return (
              <div key={day.toISOString()} className="relative border-l border-border/60" style={{ height: hours.length * HOUR_PX }}>
                {hours.map((h, i) => (
                  <div key={h} className="absolute inset-x-0 border-t border-border/40" style={{ top: i * HOUR_PX }} />
                ))}
                {sameDay(day, now) && minutesOfDay(now) >= START_HOUR * 60 && minutesOfDay(now) < END_HOUR * 60 ? (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 z-10 border-t border-red-400"
                    style={{ top: ((minutesOfDay(now) - START_HOUR * 60) / 60) * HOUR_PX }}
                  />
                ) : null}
                {dayEvents.map((e) => {
                  const s = new Date(e.startsAt);
                  const end = new Date(e.endsAt);
                  const top = Math.max(0, ((minutesOfDay(s) - START_HOUR * 60) / 60) * HOUR_PX);
                  const height = Math.max(18, ((end.getTime() - s.getTime()) / 3_600_000) * HOUR_PX - 2);
                  return (
                    <div
                      key={e.id}
                      className="group absolute inset-x-0.5 overflow-hidden rounded-md border border-border bg-muted/70 px-1.5 py-1 text-[11px] leading-tight"
                      style={{ top, height }}
                      title={`${e.title} ${s.toLocaleTimeString(LOCALE, { timeStyle: "short" })} to ${end.toLocaleTimeString(LOCALE, { timeStyle: "short" })}`}
                    >
                      <p className="truncate font-medium">{e.title}</p>
                      <p className="text-muted-foreground">{s.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" })}</p>
                      <button
                        type="button"
                        aria-label={`Remove ${e.title} from calendar`}
                        disabled={pending}
                        onClick={() => remove(e)}
                        className="absolute top-0.5 right-1 hidden text-muted-foreground group-hover:block hover:text-foreground"
                      >
                        x
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <aside className="w-full shrink-0 lg:w-64">
        <h2 className="mb-2 text-[13px] font-medium">Needs a time block</h2>
        {unscheduled.length === 0 ? (
          <p className="text-xs text-muted-foreground">Every open task with a due date this week has time set aside.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {unscheduled.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2 text-[13px]">
                <Link href={`/neuralflow/work?view=saved&task=${task.id}`} className="min-w-0 truncate hover:underline">
                  {task.title}
                </Link>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => block(task)}>
                  Block time
                </Button>
              </li>
            ))}
          </ul>
        )}
        {message ? <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
      </aside>
    </div>
  );
}
