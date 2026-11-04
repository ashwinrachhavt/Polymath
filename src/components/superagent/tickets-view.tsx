"use client";

import { useState } from "react";
import Link from "next/link";
import { AgentPanel } from "@/components/chat/agent-panel";
import { Empty, Status } from "@/components/workspace/ui";
import { cn } from "cn";
import { STAGE_META, type StageGroup, type StageKey, type TicketView } from "./view";

/*
 * The Tickets view: one list per stage group, the stage table's words on
 * every row. A row expands into the drill-down, which reuses the chat
 * surface's AgentPanel fold-out to show the ticket's mandate — who is
 * working and the procedure it was authorized under.
 */

function TicketRow({ ticket }: { ticket: TicketView }) {
  const [open, setOpen] = useState(false);
  const stage = STAGE_META[ticket.stageKey];
  return (
    <li data-testid="ticket-row" className="border-border not-last:border-b">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="hover:bg-muted/60 focus-visible:ring-ring flex w-full flex-col gap-1.5 rounded px-1 py-2.5 text-left outline-none transition-colors focus-visible:ring-2"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Status>{stage.label}</Status>
          <span className="min-w-0 flex-1 truncate text-body-dense font-medium">{ticket.title}</span>
          <span className="readout shrink-0 text-data opacity-80">{ticket.strength}</span>
        </span>
        <span className="text-muted-foreground text-xs">{ticket.reportSummary ?? "No report yet."}</span>
      </button>
      {open ? (
        <div className="border-border mb-2 flex flex-col gap-2 rounded-lg border px-3.5 py-3">
          <AgentPanel
            defaultOpen
            agent={{
              // The drill-down names the ticket: it is the one name both the
              // panel and the mandate share until a named executor exists.
              name: ticket.title,
              model: null,
              instructions: ticket.procedure,
              // The drill-down shows the mandate's procedure, not a run's
              // frozen policy: there is no capability list to report here, and
              // an empty one is the truth rather than a hidden ceiling.
              tools: [],
              ceiling: 0,
              unadvertised: 0,
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

function TicketList({ tickets, heading }: { tickets: TicketView[]; heading?: string }) {
  if (tickets.length === 0) {
    return <Empty title="No tickets here" description="No ticket is in this stage right now." />;
  }
  return (
    <ul className="flex flex-col" aria-label={heading}>
      {tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} />
      ))}
    </ul>
  );
}

/** Every group, or the one group a stage filter named — the list a count links to. */
export function TicketsView({ groups, stage }: { groups: StageGroup[]; stage?: StageKey }) {
  if (stage !== undefined) {
    const group = groups.find((item) => item.key === stage);
    return <TicketList tickets={group?.tickets ?? []} heading={group?.label} />;
  }
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-body-dense font-medium">
            {group.label}
            <span className="readout ml-2 text-data opacity-80">{group.tickets.length}</span>
          </h2>
          <TicketList tickets={group.tickets} heading={group.label} />
        </section>
      ))}
    </div>
  );
}

/** A stage-group card the Overview renders; the count is the list it links to. */
export function PersonStageCard({ group, className }: { group: StageGroup; className?: string }) {
  return (
    <Link
      href={`/supervision?view=tickets&stage=${group.key}`}
      className={cn(
        "panel hover:bg-muted/60 focus-visible:ring-ring flex items-center justify-between gap-3 rounded-xl p-4 outline-none transition-colors focus-visible:ring-2",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-body-dense font-medium">{group.label}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs">
          {group.tickets.map((ticket) => ticket.title).join(", ")}
        </span>
      </span>
      <span className="readout text-2xl">{group.tickets.length}</span>
    </Link>
  );
}
