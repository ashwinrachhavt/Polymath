import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Readout } from "@/components/readout";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import { listDocumentSearchResults, pageRuns, RUN_STATES, type RunStateFilter } from "@/domains/agents/queries";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { collectCitations } from "@/domains/knowledge/agent-search";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { listThreads, isFinished } from "@/domains/agents/thread";
import { RunControls } from "./run-controls";
import { DraftControls } from "./draft-controls";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { Markdown } from "@/components/markdown";
import { listDossiers } from "@/domains/knowledge/dossiers";
import { StartRunForm } from "./start-run-form";

export const metadata = { title: "Alfred · Polymath" };

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

const BASE = "/alfred";

/*
 * Runs older than a day that never reached a terminal state are almost
 * certainly dead (bridge restart, lost follow-up). They stay listed - the
 * record is the truth - but they are labelled so they do not read as live.
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const LIVE_STATES = new Set(["queued", "running", "waiting_input", "waiting_approval"]);

function isStaleRun(run: { state: string; createdAt: Date }) {
  return LIVE_STATES.has(run.state) && Date.now() - run.createdAt.getTime() > STALE_AFTER_MS;
}

/*
 * The stored model id is a provider routing string ("claude-hive-glm-5.3-flash").
 * Show the readable tail; the full id stays on the title attribute.
 */
function friendlyModelName(model: string) {
  const tail = model.replace(/^[a-z0-9-]*hive-/i, "").replaceAll("-", " ");
  return tail.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export async function AlfredSurface({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<RawSearchParams> } = {}) {
  // Per-request data (auth upserts touch now()); streams inside the Suspense boundary below.
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Alfred" purpose="Delegate and inspect what it did." />
        <div className="page-content">
          <EmptyState
            title="Agent storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to view runs. Agent execution also needs an Eve runtime and model credentials (EVE_BASE_URL and OPENAI_API_KEY). Set EVE_BRIDGE_SECRET (32+ characters, shared with the Eve agent) to sign runs to Eve."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { filters: { state: RUN_STATES }, defaultPageSize: 10 });
  const found = await pageRuns(auth.workspaceId, {
    query: list.q,
    state: list.filters.state as RunStateFilter | undefined,
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const runs = found.items;
  const runsFiltered = Boolean(list.q || list.filters.state);
  const dossierList = await listDossiers(auth);
  const threads = await listThreads(auth.workspaceId, runs.map((r) => r.id));
  const searchResults = await listDocumentSearchResults(auth.workspaceId, runs.map((r) => r.id));
  const runDrafts = await draftsForRuns(auth, runs.map((r) => r.id));
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

      <div className="flex flex-col gap-6 page-content">
        <Section title="Ask Alfred" description="One agent, with a stated model, tools, and budget before it starts.">
          {unavailable ? <p role="status" className="text-muted-foreground text-[13px]">{unavailable}</p> : <StartRunForm dossiers={dossierList} />}
        </Section>

        <Section title="Threads" description="A thread keeps its record context, so it does not start from nothing.">
          <EmptyState
            title="No threads yet"
            description="Threads open from a task, project, person, or from a question typed above."
          />
        </Section>

        <Section title="Recent runs" description="Every run shows its steps, questions, artifacts, and spend.">
          {found.total > 0 || runsFiltered ? (
            <ListToolbar
              searchPlaceholder="Search runs by objective or result"
              filters={[
                {
                  key: "state",
                  label: "State",
                  allLabel: "All states",
                  options: RUN_STATES.map((v) => ({ value: v, label: stateLabel[v] ?? v })),
                },
              ]}
              total={found.total}
              noun={found.total === 1 ? "run" : "runs"}
            />
          ) : null}
          {runs.length === 0 ? (
            <NoResults
              filtered={runsFiltered}
              clearHref={listHref(BASE, raw, { q: undefined, state: undefined, page: undefined })}
              emptyTitle="No runs yet"
              emptyDescription={unavailable ? "Recorded runs appear here once agent execution is connected." : "Describe an objective above to start a development run."}
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px]">{run.objective}</p>
                    <span className="flex items-center gap-1.5">
                      {isStaleRun(run) ? (
                        <Badge variant="outline" className="font-normal">
                          Stale
                        </Badge>
                      ) : null}
                      <Badge variant="secondary" className="font-normal">
                        {stateLabel[run.state] ?? run.state}
                      </Badge>
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    <Readout className="text-xs" title={run.model ?? undefined}>{run.model ? friendlyModelName(run.model) : "model unset"}</Readout>
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
                        {entry.kind === "assistant" ? <Markdown text={entry.text} /> : entry.text}
                      </li>
                    ))}
                  </ul>
                  <Citations citations={collectCitations(searchResults.get(run.id) ?? [])} />
                  {unavailable && !isFinished(run.state) ? null : <RunControls runId={run.id} finished={isFinished(run.state)} />}
                  <DraftControls runId={run.id} draft={runDrafts.get(run.id) ?? null} canSave={run.state === "succeeded" || run.state === "waiting_input"} />
                </li>
              ))}
            </ul>
          )}
          <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />
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
            {c.span.page ? <span className="text-muted-foreground"> · page {c.span.page}</span> : null}
            <p className="text-muted-foreground line-clamp-2">{c.text}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

export default function AlfredPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<AlfredSkeleton />}>
      <AlfredSurface searchParams={searchParams} />
    </Suspense>
  );
}

function AlfredSkeleton() {
  return (
    <div role="status" aria-label="Loading Alfred" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
