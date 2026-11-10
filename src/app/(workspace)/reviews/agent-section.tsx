import { Suspense } from "react";
import Link from "next/link";
import { cn } from "cn";
import { Screen } from "@/components/workspace/ui";
import { OverviewPanel } from "@/components/superagent/overview-panel";
import { SettingsPanel } from "@/components/superagent/settings-panel";
import { TicketsView } from "@/components/superagent/tickets-view";
import { isStageKey, superviseTickets, type StageKey } from "@/components/superagent/view";
import { createSuperagentStore, getPolicy } from "@/domains/superagent/store";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";

/*
 * What used to be the Supervision page, now a section of Reviews: the queue is
 * what needs a person, these views are what the agent is doing around it.
 */
const REVIEW_VIEWS = ["proposals", "overview", "tickets", "settings"] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];

export function readReviewView(value: string | string[] | undefined): ReviewView {
  return typeof value === "string" && (REVIEW_VIEWS as readonly string[]).includes(value)
    ? (value as ReviewView)
    : "proposals";
}

export function readStage(value: string | string[] | undefined): StageKey | undefined {
  return typeof value === "string" && isStageKey(value) ? value : undefined;
}

export function ReviewTabs({ active }: { active: ReviewView }) {
  const tabs: { view: ReviewView; label: string }[] = [
    { view: "proposals", label: "Proposals" },
    { view: "overview", label: "Agent overview" },
    { view: "tickets", label: "Tickets" },
    { view: "settings", label: "Agent settings" },
  ];
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Review sections">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          href={tab.view === "proposals" ? "/reviews" : `/reviews?view=${tab.view}`}
          aria-current={tab.view === active ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-body-dense outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab.view === active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
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

export function AgentSection({ view, stage }: { view: Exclude<ReviewView, "proposals">; stage: StageKey | undefined }) {
  return (
    <Screen
      title="Reviews"
      description="What the agent is doing, and what needs a person."
      actions={<ReviewTabs active={view} />}
    >
      <Suspense fallback={<p className="text-muted-foreground text-body-dense">Loading…</p>}>
        {view === "tickets" ? (
          <TicketsSurface stage={stage} />
        ) : view === "settings" ? (
          <SettingsSurface />
        ) : (
          <OverviewPanel />
        )}
      </Suspense>
    </Screen>
  );
}
