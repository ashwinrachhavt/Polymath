import { CalendarDays, Clock, Inbox, ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Briefing · Axiom" };

/*
 * The cockpit. Every panel reads from a domain that does not have its queries
 * yet, so each one states what will fill it rather than rendering an empty
 * list as though the answer were "nothing".
 *
 * Deterministic priority reasons are part of the contract: when outcomes land,
 * each card carries why it was chosen, not just that it was.
 */
export default function BriefingPage() {
  return (
    <>
      <PageHeader
        title="Briefing"
        purpose="Decide what to do today."
        actions={
          <Badge variant="secondary" className="font-normal">
            No calendar connected
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section
          title="Today's outcomes"
          description="Accept up to three. Each one explains why it is here."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {[1, 2, 3].map((slot) => (
              <Card key={slot} className="border-dashed">
                <CardContent className="text-muted-foreground py-5 text-sm">
                  Accepted outcome {slot}
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Three slots, ranked by deadline, dependencies, calendar fit, and what you already committed
            to. Each one will say why it was chosen.
          </p>
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Agenda" description="What the day already holds.">
            <EmptyState
              title="No calendar connected"
              description="Connect Google Calendar to see today's events and free time."
              action={
                <a href="/settings" className="text-primary text-sm hover:underline">
                  Connect a calendar
                </a>
              }
            />
          </Section>

          <Section title="Waiting on" description="Commitments that depend on someone else.">
            <EmptyState
              title="Nothing is waiting"
              description="Items you are waiting on, and follow-ups that are going stale, appear here."
            />
          </Section>

          <Section title="Needs a decision" description="Reviews that are older than they should be.">
            <EmptyState
              title="No decisions pending"
              description="Action proposals and generated output land here for approval."
              action={
                <a href="/reviews" className="text-primary text-sm hover:underline">
                  Open reviews
                </a>
              }
            />
          </Section>

          <Section title="Running work" description="Agent runs and imports in flight.">
            <EmptyState
              title="Nothing is running"
              description="Long jobs show progress, cost, and a way to cancel them here."
            />
          </Section>
        </div>

        <Section title="Today at a glance">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Captured", value: "—", hint: "Items waiting in Inbox" },
              { label: "Completed", value: "—", hint: "Tasks finished today" },
              { label: "Focused", value: "—", hint: "Minutes in focus sessions" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="border-border flex items-center gap-3 rounded-xl border px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs">{stat.label}</p>
                  <p className="text-lg font-medium tabular-nums">{stat.value}</p>
                  <p className="text-muted-foreground truncate text-xs">{stat.hint}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Sync health">
          <div className="text-muted-foreground flex flex-wrap gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <Inbox aria-hidden className="size-4" /> Inbox: not connected
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarDays aria-hidden className="size-4" /> Calendar: not connected
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck aria-hidden className="size-4" /> Connectors: 0 active
            </span>
            <span className="flex items-center gap-1.5">
              <Clock aria-hidden className="size-4" /> Last sync: never
            </span>
          </div>
        </Section>
      </div>
    </>
  );
}
