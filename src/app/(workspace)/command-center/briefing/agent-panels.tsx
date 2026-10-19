import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Status } from "@/components/workspace/ui";
import { countPendingProposals, listTopPendingProposals } from "@/domains/actions/queries";
import { overnightRuns } from "@/domains/agents/queries";
import { getAuthContext } from "@/lib/auth";

/*
 * The agent half of the Briefing: what ran, and what is waiting on the owner.
 * Both panels read the canonical records (action_proposals, agent_runs) -
 * the same rows /reviews and /alfred show, not a rehearsal. Rendered as its
 * own suspense child so the task panels are not blocked on it.
 */

const OVERNIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;

/* "Overnight" is a rolling window: the last 24 hours of canonical runs. */
function overnightSince(): Date {
  return new Date(Date.now() - OVERNIGHT_WINDOW_MS);
}

function timeLabel(date: Date): string {
  return date.toISOString().slice(11, 16);
}

const runStateLabel: Record<string, string> = {
  queued: "queued",
  running: "running",
  waiting_input: "waiting for input",
  waiting_approval: "waiting for approval",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export async function AgentPanels() {
  const auth = await getAuthContext();
  const since = overnightSince();
  const [pendingCount, topPending, overnight] = await Promise.all([
    countPendingProposals(auth.workspaceId),
    listTopPendingProposals(auth.workspaceId, 3),
    overnightRuns(auth.workspaceId, since),
  ]);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Panel
        title="Needs your judgment"
        description={
          pendingCount > topPending.length
            ? `${pendingCount - topPending.length} more in the queue.`
            : pendingCount > 0
              ? "Nothing else is waiting."
              : undefined
        }
        actions={
          pendingCount > 0 ? (
            <Button variant="outline" size="sm" asChild>
              <Link href="/reviews">Open Reviews</Link>
            </Button>
          ) : undefined
        }
      >
        <div className="divide-y divide-border">
          {topPending.map((proposal) => (
            <div key={proposal.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <Link href="/reviews" className="text-[13px] font-medium hover:underline">
                  {proposal.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {proposal.capability} · {proposal.riskClass.replace("_", " ")} · {timeLabel(proposal.createdAt)} UTC
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/reviews">Review</Link>
              </Button>
            </div>
          ))}
        </div>
        {pendingCount === 0 ? (
          <Empty
            title="Nothing needs your judgment"
            description="When an agent wants to change something outside Axiom, it proposes the exact payload in Reviews first."
          />
        ) : null}
      </Panel>

      <Panel
        title="Agents overnight"
        description="The last 24 hours of runs, from the canonical run record."
        actions={
          <Status>
            {overnight.total} {overnight.total === 1 ? "run" : "runs"} · {overnight.failed > 0 ? `${overnight.failed} failed` : "nothing failed"}
          </Status>
        }
      >
        <div className="divide-y divide-border">
          {overnight.items.map((run) => (
            <div key={run.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-[13px] font-medium">{run.profileName ?? "alfred"}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {run.summary ?? run.objective} · {runStateLabel[run.state] ?? run.state}
                </p>
              </div>
              <span className="readout text-xs text-muted-foreground">{timeLabel(run.endedAt ?? run.createdAt)}</span>
            </div>
          ))}
        </div>
        {overnight.items.length === 0 ? (
          <Empty title="No runs in the last 24 hours" description="Start work from Alfred or hire a specialist; their runs log here." />
        ) : null}
      </Panel>
    </div>
  );
}
