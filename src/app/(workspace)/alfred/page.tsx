import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Readout } from "@/components/readout";
import { connection } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { listDocumentSearchResults, listRecentRuns } from "@/domains/agents/queries";
import { collectCitations } from "@/domains/knowledge/agent-search";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { listThreads, isFinished } from "@/domains/agents/thread";
import { RunControls } from "./run-controls";
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
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Alfred" purpose="Delegate and inspect what it did." />
        <div className="px-4 py-5 md:px-6">
          <EmptyState
            title="Agent storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to view runs. Agent execution also needs an Eve runtime and model credentials (EVE_BASE_URL and OPENAI_API_KEY). Set EVE_BRIDGE_SECRET (32+ characters, shared with the Eve agent) to sign runs to Eve."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const runs = await listRecentRuns(auth.workspaceId, 8);
  const threads = await listThreads(auth.workspaceId, runs.map((r) => r.id));
  const searchResults = await listDocumentSearchResults(auth.workspaceId, runs.map((r) => r.id));
  const unavailable = eveBridgeUnavailableReason();

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
          {unavailable ? <p role="status" className="text-muted-foreground text-[13px]">{unavailable}</p> : <StartRunForm />}
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
              description={unavailable ? "Recorded runs appear here once agent execution is connected." : "Describe an objective above to start a development run."}
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
                  <ul className="flex flex-col gap-1">
                    {(threads.get(run.id) ?? []).map((entry) => (
                      <li
                        key={entry.sequence}
                        className={entry.kind === "user" ? "text-[13px]" : "text-muted-foreground text-[13px]"}
                      >
                        <span className="text-muted-foreground text-xs">
                          {entry.kind === "user" ? "You" : entry.kind === "assistant" ? "Alfred" : "Run"}:{" "}
                        </span>
                        {entry.text}
                      </li>
                    ))}
                  </ul>
                  <Citations citations={collectCitations(searchResults.get(run.id) ?? [])} />
                  {unavailable && !isFinished(run.state) ? null : <RunControls runId={run.id} finished={isFinished(run.state)} />}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

/* Sources Alfred read for a run: the passages its documents.search calls returned. */
function Citations({ citations }: { citations: ReturnType<typeof collectCitations> }) {
  if (citations.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground cursor-pointer">
        {citations.length} {citations.length === 1 ? "source" : "sources"} read
      </summary>
      <ol className="mt-1 flex flex-col gap-1.5">
        {citations.map((c) => (
          <li key={`${c.documentId}:${c.span.start}`}>
            <span className="text-[13px]">{c.title}</span>
            <span className="text-muted-foreground">
              {c.span.page ? ` · page ${c.span.page}` : ""} · chars {c.span.start}-{c.span.end}
            </span>
            <p className="text-muted-foreground line-clamp-2">{c.text}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
