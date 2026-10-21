import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/markdown";
import { ChatSurface } from "@/components/chat/chat-surface";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { getRun, getRunPolicySnapshot, listDocumentSearchResults, listRunEvents, listRunToolCalls } from "@/domains/agents/queries";
import { listThreads } from "@/domains/agents/thread";
import { collectCitations } from "@/domains/knowledge/agent-search";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { RunDetails } from "./details";

export const metadata = { title: "Conversation · Polymath" };

/*
 * One conversation, full page. The home lists rows; this is what a row opens.
 *
 * The transcript is the page. Everything the home shed about the run - model,
 * tools, budget, sources, timeline, controls - sits behind the Details
 * disclosure, because those are for when the owner is auditing what happened,
 * not for reading the answer. Decisions on approvals live in Reviews: this page
 * states that a run is waiting and links there rather than growing a second
 * decision surface.
 */

const ATTENTION_STATES = new Set(["waiting_input", "waiting_approval"]);

async function ConversationSurface({ runId }: { runId: string }) {
  await connection();
  const auth = await getAuthContext();
  // A malformed id would reach Postgres as a uuid cast error and 500; the API
  // route answers 404 for it, and this page must answer the same.
  if (!z.string().uuid().safeParse(runId).success) notFound();
  const run = await getRun(auth.workspaceId, runId);
  // Missing and other-workspace are the same answer on purpose (see getRun).
  if (!run) notFound();

  const [threads, searchResults, events, policy, drafts, toolCalls] = await Promise.all([
    listThreads(auth.workspaceId, [run.id]),
    listDocumentSearchResults(auth.workspaceId, [run.id]),
    listRunEvents(auth.workspaceId, run.id),
    getRunPolicySnapshot(run.id, auth.workspaceId),
    draftsForRuns(auth, [run.id]),
    listRunToolCalls(auth.workspaceId, run.id),
  ]);

  const thread = threads.get(run.id) ?? [];
  const citations = collectCitations(searchResults.get(run.id) ?? []);
  const unavailable = eveBridgeUnavailableReason();
  // Mirrors the server's own terminal set: a run that has not finished may still
  // produce events, so it streams; anything else is history.
  const isLive = !["succeeded", "failed", "cancelled"].includes(run.state) && !unavailable;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * One compact header, not the destination-sized one: the transcript is
       * the page, and the objective is a label on it. The page header itself
       * stays because app screens always name what they show; everything else
       * about the run is in Details.
       */}
      <header className="page-header border-border bg-background/95 sticky top-12 z-10 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-[var(--page-width)] items-center gap-3">
          <Link
            href="/alfred"
            aria-label="Back to recent conversations"
            className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline-offset-4 hover:underline"
          >
            <span aria-hidden>←</span> Recent
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] leading-tight font-medium">{run.objective}</h1>
            <p className="text-muted-foreground truncate text-[11px]">
              Started {timeAgo(run.createdAt)}
              {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            </p>
          </div>
          {ATTENTION_STATES.has(run.state) ? (
            <div className="flex shrink-0 items-center">
              <Link
                href="/reviews"
                className="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-3"
              >
                <Badge variant="secondary" className="font-normal">
                  Needs your reply
                </Badge>
              </Link>
            </div>
          ) : null}
        </div>
      </header>

      <div className="page-content flex min-h-0 flex-1 flex-col gap-4">
        <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col gap-3">
          {/*
           * A live run streams; a finished one keeps the stored transcript.
           * Rendering the snapshot for a running run was the whole reason a new
           * conversation appeared frozen: the server read the thread once, and
           * nothing on the page ever asked again.
           */}
          {isLive ? (
            <ChatSurface
              runId={run.id}
              subject={{ type: "artifact", id: run.id }}
              optimisticMessage={run.objective}
              placeholder="Reply to continue…"
              showHeader={false}
              className="min-h-0 flex-1"
            />
          ) : thread.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              This conversation has no messages yet.
            </p>
          ) : (
            thread.map((entry) => (
              <article key={entry.sequence} className="flex flex-col gap-1.5">
                <p className="text-muted-foreground text-xs">
                  {entry.kind === "user" ? "You" : entry.kind === "assistant" ? "Polymath" : entry.kind === "reasoning" ? "Thinking" : "Run"}
                  {" · "}
                  {timeAgo(entry.at)}
                </p>
                {entry.kind === "assistant" ? (
                  <div className="text-[13px] leading-relaxed">
                    <Markdown text={entry.text} />
                  </div>
                ) : entry.kind === "reasoning" ? (
                  // The model's visible rationale, kept from the live stream. A
                  // quiet disclosure, not a transcript body: it is evidence for
                  // the answer above it, not the thing being read.
                  <details className="max-w-[72ch]">
                    <summary className="text-muted-foreground cursor-pointer text-[13px] hover:text-foreground">
                      Show thinking
                    </summary>
                    <p className="text-muted-foreground mt-2 text-[13px] whitespace-pre-wrap">{entry.text}</p>
                  </details>
                ) : (
                  <p className="text-[13px] whitespace-pre-wrap">{entry.text}</p>
                )}
              </article>
            ))
          )}

          <RunDetails
            run={run}
            policy={policy}
            citations={citations}
            events={events}
            toolCalls={toolCalls}
            draft={drafts.get(run.id) ?? null}
            unavailable={unavailable}
          />
        </section>
      </div>
    </div>
  );
}

/*
 * A Suspense boundary is required, not decorative: `cacheComponents` refuses to
 * prerender a route that awaits `connection()` outside one, and the workspace
 * group's loading.tsx shell does not count. The fallback matches the shell so a
 * navigation does not flash a second skeleton.
 */
export default async function ConversationPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense fallback={<ConversationSkeleton />}>
      <ConversationSurface runId={runId} />
    </Suspense>
  );
}

function ConversationSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="page-content flex flex-col gap-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
