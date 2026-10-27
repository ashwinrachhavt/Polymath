import Link from "next/link";
import { listEventsBetween } from "@/domains/calendar/queries";
import { getPreferences } from "@/domains/identity/preferences";
import type { AuthContext } from "@/domains/identity/resolve";
import { listTasksDueBetween } from "@/domains/work/queries";
import { dateKeyInTimezone, todayKeyInTimezone } from "@/lib/local-date";
import { PrepButton } from "./prep-button";

/*
 * The day in one line: what is next, when focus is blocked out, what is due.
 * This replaces the four stacked cards (Upcoming, Focus Windows, Next Events,
 * month calendar) that used to sit under the list as a second screen's worth
 * of bordered blocks. The month calendar moved to the Calendar view, where a
 * month grid is the point; here one line is enough to answer "is there
 * anything I am about to walk into".
 */

const DAY = 86_400_000;

function clock(d: Date, timeZone: string) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

export async function DayStrip({ auth }: { auth: AuthContext }) {
  const { timezone } = await getPreferences(auth);
  const now = new Date();
  const today = todayKeyInTimezone(timezone, now);
  const [events, dueToday] = await Promise.all([
    listEventsBetween(auth, now, new Date(now.getTime() + DAY)),
    listTasksDueBetween(auth, today, today),
  ]);

  // Every event still ahead today keeps its Prep action: collapsing the old
  // Next Events card into one line must not make prep reachable for only the
  // single next event.
  const upcoming = events.filter((e) => e.endsAt > now && !e.taskId);
  const focus = events.find((e) => e.taskId && dateKeyInTimezone(e.startsAt, timezone) === today && e.endsAt > now);
  const due = dueToday.filter((t) => t.status !== "done" && t.status !== "cancelled");

  return (
    <ul className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
      <li className="text-foreground">
        {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone })}
      </li>
      {upcoming.length === 0 ? (
        <li>Next nothing scheduled</li>
      ) : (
        upcoming.map((event, index) => (
          <li key={event.id}>
            {index === 0 ? "Next " : ""}
            <span className="text-foreground">
              {event.title} {clock(event.startsAt, timezone)}
            </span>
            <PrepButton eventId={event.id} />
          </li>
        ))
      )}
      <li>
        Focus{" "}
        {focus ? (
          <span className="readout text-foreground">
            {clock(focus.startsAt, timezone)} to {clock(focus.endsAt, timezone)}
          </span>
        ) : (
          "none blocked"
        )}
      </li>
      <li>
        <span className="readout text-foreground">{due.length}</span> due today
      </li>
      <li className="ml-auto">
        <Link href="/neuralflow/work?view=calendar" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline">
          Week
        </Link>
      </li>
    </ul>
  );
}
