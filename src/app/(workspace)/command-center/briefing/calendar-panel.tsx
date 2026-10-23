import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, Panel } from "@/components/workspace/ui";
import { getTodayAgenda, type AgendaAccount } from "@/domains/integrations/calendar-agenda";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";

/*
 * The calendar half of the Briefing (spec: the briefing knows the calendar,
 * and tells plainly when it cannot). Read-only: the domain read never writes
 * to Google or the local event store.
 *
 * Freshness contract: this panel is its own suspense child and reads LIVE on
 * every request - it is never wrapped in the page's cached briefing data, so
 * a cached app shell cannot serve a stale agenda. The day label and the as-of
 * note both come from the read itself (workspace-local day + fetch instant),
 * so a page whose shell crossed local midnight still labels the day the read
 * actually covered. Event presence is today's agenda on the connected
 * calendar accounts - never a claim of full free/busy availability.
 */

function eventTime(startsAt: string, allDay: boolean, timezone: string): string {
  if (allDay) return "All day";
  const at = new Date(startsAt);
  if (!Number.isFinite(at.getTime())) return startsAt;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(at);
}

function AccountAgenda({ account, timezone, single }: { account: AgendaAccount; timezone: string; single: boolean }) {
  if (account.status === "unconfigured") {
    return <p className="py-2 text-[13px] text-muted-foreground">{account.alias} is not configured yet - connect it under Integrations to see its events.</p>;
  }
  if (account.status === "unavailable") {
    return <p className="py-2 text-[13px] text-muted-foreground">{account.alias} could not be read: {account.reason}</p>;
  }
  return (
    <div>
      {!single ? <p className="pt-2 text-xs font-medium text-muted-foreground">{account.alias}</p> : null}
      {account.events.length === 0 ? (
        <p className="py-2 text-[13px] text-muted-foreground">No events on the {single ? "primary calendar" : `${account.alias} primary calendar`} today.</p>
      ) : (
        <div className="divide-y divide-border">
          {account.events.map((event) => (
            <div key={event.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3 first:pt-1">
              <div>
                <p className="text-[13px] font-medium">{event.title}</p>
                {event.location ? <p className="mt-0.5 text-xs text-muted-foreground">{event.location}</p> : null}
              </div>
              <span className="readout text-xs text-muted-foreground">{eventTime(event.startsAt, event.allDay, timezone)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export async function CalendarPanel() {
  const auth = await getAuthContext();
  const agenda = await getTodayAgenda(auth);

  if (agenda.status === "not_connected") {
    return (
      <Panel title="Today's agenda">
        <Empty
          title="No calendar connected"
          description="Connect Google Calendar and the briefing shows today's events here - and says so plainly whenever it cannot read them."
          action={<Button variant="outline" size="sm" asChild><Link href="/command-center/integrations">Connect Google Calendar</Link></Button>}
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Today's agenda"
      description={`${agenda.day} · ${agenda.timezone} · read ${timeAgo(agenda.asOf)}`}
    >
      <p className="pb-1 text-[11px] text-muted-foreground">Each account&apos;s primary calendar{agenda.accounts.length > 1 ? "s" : ""}.</p>
      {agenda.accounts.map((account) => (
        <AccountAgenda key={account.alias} account={account} timezone={agenda.timezone} single={agenda.accounts.length === 1} />
      ))}
    </Panel>
  );
}
