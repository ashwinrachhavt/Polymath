import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, StatStrip } from "@/components/workspace/ui";
import { getDayPage } from "@/domains/daybook/queries";
import { getAuthContext } from "@/lib/auth";
import { PinControls, UnpinButton } from "./pin-controls";

export const metadata = { title: "Day · Polymath" };

/*
 * The day page (eng review D6/D10): a read-only record of what happened on a
 * local date. It is a child of Today — no rail entry — and carries no
 * mutations of its own except pinning (actions.ts). Every section derives
 * from canonical records; each row links the record, never a copy.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatTime(at: Date | null): string {
  if (!at) return "";
  return at.toISOString().slice(11, 16);
}

function ItemRows({ items }: { items: Array<{ id: string; title: string; at: Date | null }> }) {
  if (!items.length) return null;
  return (
    <div className="divide-y divide-border">
      {items.map((item) => (
        <div key={item.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
          <span className="text-[13px]">{item.title}</span>
          <span className="text-xs text-muted-foreground">{formatTime(item.at)}</span>
        </div>
      ))}
    </div>
  );
}

async function DaySurface({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  await connection();
  const auth = await getAuthContext();

  if (!DATE_RE.test(date)) {
    return (
      <Screen title="Day">
        <Empty title="That date does not exist" description="Use a date like 2026-10-22." />
      </Screen>
    );
  }

  let day: Awaited<ReturnType<typeof getDayPage>>;
  try {
    day = await getDayPage(auth, date);
  } catch (error) {
    return (
      <Screen title="Day">
        <Empty
          title="Could not load this day"
          description={error instanceof Error ? error.message : "Something went wrong reading the day."}
        />
      </Screen>
    );
  }

  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <Screen
      title={label}
      actions={<Button asChild variant="outline" size="sm"><Link href="/command-center/inbox">Back to Inbox</Link></Button>}
    >
      {/* The day in three numbers (mockup 2026-10-28): what arrived, what
          changed, how much of the record has a source behind it. */}
      <StatStrip
        className="grid-cols-1 sm:grid-cols-3"
        items={[
          { label: "Captured", value: day.captured.length, hint: "What arrived this day." },
          { label: "Finished", value: day.workedOn.length, hint: "What changed, from your own saves." },
          { label: "Focus", value: day.sessions.length, hint: "Sessions touching this day." },
        ]}
      />

      {day.created.length ? (
        <Panel title="Created" description="What came into being this day.">
          <ItemRows items={day.created} />
        </Panel>
      ) : null}

      {day.workedOn.length ? (
        <Panel title="Worked on" description="What changed this day, from your own saves.">
          <ItemRows items={day.workedOn} />
        </Panel>
      ) : null}

      {day.captured.length ? (
        <Panel title="Captured" description="What arrived this day.">
          <ItemRows items={day.captured} />
        </Panel>
      ) : null}

      {day.sessions.length ? (
        <Panel title="Focus" description="Sessions touching this day.">
          <div className="divide-y divide-border">
            {day.sessions.map((session) => (
              <div key={session.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
                <span className="text-[13px]">{session.subject ?? "Focus session"}</span>
                <span className="text-xs text-muted-foreground">{session.minutes} min</span>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {day.meetings.length ? (
        <Panel title="Meetings" description="Scheduled time this day.">
          <ItemRows items={day.meetings} />
        </Panel>
      ) : null}

      {day.pins.length ? (
        <Panel title="Kept" description="What you pinned to this day.">
          <div className="divide-y divide-border">
            {day.pins.map((pin) => (
              <div key={pin.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0">
                <span className="text-[13px]">
                  {pin.title}
                  {pin.archived ? " · archived" : ""}
                  {pin.pinnedVersionNumber ? ` · version ${pin.pinnedVersionNumber}` : ""}
                </span>
                <UnpinButton localDate={date} artifactId={pin.artifactId} />
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Keep something from this day" description="Pinned records stay on this day even as they change.">
        <PinControls
          localDate={date}
          candidates={[...day.created, ...day.workedOn]
            .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
            .map((item) => ({ id: item.id, title: item.title }))}
        />
      </Panel>

      {!day.created.length &&
      !day.workedOn.length &&
      !day.captured.length &&
      !day.sessions.length &&
      !day.meetings.length &&
      !day.pins.length ? (
        <Empty
          title={`Nothing recorded on ${label}`}
          description="Work on something and it will show up here."
        />
      ) : null}
    </Screen>
  );
}

/*
 * `connection()` must sit inside a Suspense boundary under cacheComponents,
 * or navigation treats the day as uncached data.
 */
export default function DayPage({ params }: { params: Promise<{ date: string }> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading day…</p>}>
      <DaySurface params={params} />
    </Suspense>
  );
}
