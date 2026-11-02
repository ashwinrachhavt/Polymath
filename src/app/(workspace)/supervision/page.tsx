import { Suspense } from "react";
import { Screen } from "@/components/workspace/ui";
import { OverviewPanel } from "@/components/superagent/overview-panel";
import { SettingsPanel } from "@/components/superagent/settings-panel";
import { TicketsView } from "@/components/superagent/tickets-view";
import { isStageKey, superviseTickets, type StageKey } from "@/components/superagent/view";
import { createSuperagentStore, getPolicy } from "@/domains/superagent/store";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import Link from "next/link";
import { cn } from "cn";

const VIEWS = ["overview", "tickets", "settings"] as const;
type View = (typeof VIEWS)[number];

type Query = Promise<Record<string, string | string[] | undefined>>;

function readView(value: string | string[] | undefined): View {
  return typeof value === "string" && (VIEWS as readonly string[]).includes(value) ? (value as View) : "overview";
}

function readStage(value: string | string[] | undefined): StageKey | undefined {
  return typeof value === "string" && isStageKey(value) ? value : undefined;
}

function SupervisionTabs({ active }: { active: View }) {
  const tabs: { view: View; label: string }[] = [
    { view: "overview", label: "Overview" },
    { view: "tickets", label: "Tickets" },
    { view: "settings", label: "Settings" },
  ];
  return (
    <nav className="flex gap-1" aria-label="Supervision sections">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          href={`/supervision?view=${tab.view}`}
          aria-current={tab.view === active ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab.view === active
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

async function TicketsSurface({ stage }: { stage: StageKey | undefined }) {
  const auth = await getAuthContext();
  const store = createSuperagentStore(db, auth.workspaceId);
  await store.hydrate();
  return <TicketsView groups={superviseTickets(store.repositories.tickets.list())} stage={stage} />;
}

async function SettingsSurface() {
  const auth = await getAuthContext();
  const stored = await getPolicy(db, auth.workspaceId);
  return (
    <SettingsPanel
      policy={{
        paused: stored?.policy.paused ?? false,
        acceptMode: stored?.policy.acceptMode ?? "off",
        version: stored?.policy.version ?? "none",
        rules: stored?.rules.map(({ id, name, instruction, enabled }) => ({ id, name, instruction, enabled })) ?? [],
      }}
    />
  );
}

function TicketsFallback() {
  return <p className="text-muted-foreground text-[13px]">Loading tickets…</p>;
}

export default async function SupervisionPage({ searchParams }: { searchParams: Query }) {
  const query = await searchParams;
  const view = readView(query.view);
  const stage = readStage(query.stage);
  return (
    <Screen
      title="Supervision"
      description="What the agent is doing, and what needs a person."
      actions={<SupervisionTabs active={view} />}
    >
      {view === "tickets" ? (
        <Suspense fallback={<TicketsFallback />}>
          <TicketsSurface stage={stage} />
        </Suspense>
      ) : view === "settings" ? (
        <Suspense fallback={<p className="text-muted-foreground text-[13px]">Loading policy…</p>}>
          <SettingsSurface />
        </Suspense>
      ) : (
        <Suspense fallback={<p className="text-muted-foreground text-[13px]">Loading overview…</p>}>
          <OverviewPanel />
        </Suspense>
      )}
    </Screen>
  );
}
