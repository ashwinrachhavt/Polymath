import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel, Status } from "@/components/workspace/ui";
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

/*
 * The queue description must never contradict the rows beneath it: with
 * proposals listed, "nothing is waiting" copy is a lie even when technically
 * about the unlisted remainder. Three states only - overflow count, all
 * shown, or none at all (no description; the body says it).
 */
export function pendingQueueDescription(pendingCount: number, shownCount: number): string | undefined {
  if (pendingCount > shownCount) return `${pendingCount - shownCount} more in the queue.`;
  if (pendingCount > 0) return "Everything waiting is listed here.";
  return undefined;
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
        description={pendingQueueDescription(pendingCount, topPending.length)}
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
          <p className="text-[13px] text-muted-foreground">Nothing is waiting on you.</p>
        ) : null}
      </Panel>

      <Panel
        title="Agents overnight"
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
          <p className="text-[13px] text-muted-foreground">No runs yet.</p>
        ) : null}
      </Panel>
    </div>
  );
}
