import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Readout } from "@/components/readout";
import { connection } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { listRecentRuns } from "@/domains/agents/queries";
import { StartRunForm } from "./start-run-form";

export const metadata = { title: "Alfred · Axiom" };

/*
 * Conversation, delegation, and the run timeline. Reads the workspace's real
 * run rows; the form posts to /api/v1/runs, which drives the engine.
 */

const stateLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default async function AlfredPage() {
  // Per-request data (auth upserts touch now()); opt this route out of prerender.
  await connection();
  const auth = await getAuthContext();
  const runs = await listRecentRuns(auth.workspaceId, 8);

  return (
    <>
      <PageHeader
        title="Alfred"
        purpose="Delegate and inspect what it did."
        actions={
          <Badge variant="secondary" className="font-normal">
            Profile: alfred
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Ask Alfred" description="One agent, with a stated model, tools, and budget before it starts.">
          <StartRunForm />
        </Section>

        <Section title="Threads" description="A thread keeps its record context, so it does not start from nothing.">
          <EmptyState
            title="No threads yet"
            description="Threads open from a task, project, person, or from a question typed above."
          />
        </Section>

        <Section title="Recent runs" description="Every run shows its steps, questions, artifacts, and spend.">
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Describe an objective above and start one. A run is durable: reloading rebuilds its timeline, retries create a new run, and finished runs never change."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px]">{run.objective}</p>
                    <Badge variant="secondary" className="font-normal">
                      {stateLabel[run.state] ?? run.state}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    <Readout className="text-xs">{run.model ?? "model unset"}</Readout>
                    {" · "}
                    {run.summary ?? run.error ?? "in progress"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
