import { connection } from "next/server";
import { Suspense } from "react";
import { Empty, Panel, Screen, Stat, Status } from "@/components/workspace/ui";
import { getRewardsOverview, pickRewardAnnouncement } from "@/domains/gamification/queries";
import { getAuthContext } from "@/lib/auth";
import { CoachMark } from "@/components/shell/coach-mark";
import { ClaimShardButton } from "./claim-button";
import { DefinitionForm } from "./definition-form";
import { Jewels } from "./jewels";

export const metadata = { title: "Stones & rewards · Polymath" };

/*
 * The stone collection, durable (ASH-137 A10): totals are derived from the
 * append-only ledger at render, the catalog is workspace reward definitions,
 * and history is the newest ledger entries. The earning rules are the
 * owner's (decided 2026-10-18): the daily Quartz lands on the first
 * completed task of the day, and shards are claimed by hand - five stones,
 * one shard, never auto-converted.
 */

function when(iso: Date): string {
  return iso.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

async function Rewards() {
  await connection();
  const auth = await getAuthContext();
  const overview = await getRewardsOverview(auth);
  const announcement = pickRewardAnnouncement(overview.ledger, new Date());

  return (
    <Screen
      title="Stone collection"
      description="The ledger is the truth: every stone, streak and badge is a row, and the totals below are derived from it at render. The first task you finish each day earns the Quartz; five stones fuse into a shard you claim by hand."
    >
      <Jewels overview={overview} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="relative">
          <Stat label="Points earned" value={overview.totalPoints} hint="Derived from the ledger, never stored" />
          {announcement ? (
            <CoachMark
              id={`stone-${announcement.id}`}
              title={announcement.milestone ? "Milestone reached" : "Stone earned"}
              actionLabel="View"
            >
              {announcement.definitionLabel} · +{announcement.points} pts · {announcement.reason.replaceAll("_", " ")}. The collection is below.
            </CoachMark>
          ) : null}
        </div>
        <Stat label="Active days" value={overview.activeDays} hint="Days with at least one entry" />
        <Stat label="Reward definitions" value={overview.definitions.length} hint="The catalog earning rules reference" />
      </div>

      <Panel
        title="Shards"
        description={`${overview.shards.stones} stone(s) recorded, ${overview.shards.claimed} shard(s) claimed. Five stones fuse into one shard - claimed by hand, never auto-converted.`}
      >
        <ClaimShardButton claimable={overview.shards.claimable} />
      </Panel>

      <Panel title="Definitions" description="What a reward is. Defining one changes no balances and awards nothing.">
        <div className="divide-y divide-border">
          {overview.definitions.map((definition) => (
            <div key={definition.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-[13px] font-medium">
                  {definition.label} <span className="text-muted-foreground">({definition.key})</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {definition.kind} · {definition.points} pts{definition.threshold > 1 ? ` · needs ${definition.threshold}` : ""}
                  {definition.description ? ` · ${definition.description}` : ""}
                </p>
              </div>
              <Status>{definition.active ? "active" : "disabled"}</Status>
            </div>
          ))}
          {!overview.definitions.length ? (
            <Empty title="No rewards defined" description="Define the catalog the earning rules will reference." />
          ) : null}
        </div>
      </Panel>

      <Panel title="New definition" description="Catalog rows only - this form never awards points.">
        <DefinitionForm />
      </Panel>

      <Panel title="Ledger" description="Newest entries first. The ledger is append-only; a reversal is a new negative row, never a delete.">
        <div className="divide-y divide-border">
          {overview.ledger.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-[13px] font-medium">{entry.definitionLabel}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.reason.replaceAll("_", " ")} · {when(entry.createdAt)}
                </p>
              </div>
              <p className="font-mono text-[13px] tabular-nums">{entry.points > 0 ? `+${entry.points}` : entry.points}</p>
            </div>
          ))}
          {!overview.ledger.length ? (
            <Empty title="Nothing earned yet" description="Finish your first task of the day and the Quartz lands here." />
          ) : null}
        </div>
      </Panel>
    </Screen>
  );
}

export default function RewardsPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening the stone collection…</p>}>
      <Rewards />
    </Suspense>
  );
}
