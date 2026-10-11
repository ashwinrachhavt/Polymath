import { CalendarDays, Clock, Inbox, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";

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
          {/* Three slots, numbered because they genuinely are a ranked
              sequence — the rank is the information, not decoration. */}
          <div className="grid gap-3 sm:grid-cols-3">
            {[1, 2, 3].map((slot) => (
              <div
                key={slot}
                className="panel-empty flex flex-col gap-2 rounded-lg px-3.5 py-4"
              >
                <Readout className="text-muted-foreground text-[11px]">
                  Rank {slot}
                </Readout>
                <p className="text-muted-foreground text-[13px]">Not accepted yet</p>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-[13px]">
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
                <Link href="/settings" className="text-app-accent text-[13px] rounded-sm hover:underline focus-visible:ring-ring focus-visible:ring-3 focus-visible:outline-none">
                  Connect a calendar
                </Link>
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
                <Link href="/reviews" className="text-app-accent text-[13px] rounded-sm hover:underline focus-visible:ring-ring focus-visible:ring-3 focus-visible:outline-none">
                  Open reviews
                </Link>
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

        <Section title="Sync health">
          <div className="text-muted-foreground flex flex-wrap gap-4 text-[13px]">
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
