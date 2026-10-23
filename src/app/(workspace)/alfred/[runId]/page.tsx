import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/markdown";
import { ChatCancel, ChatSurface } from "@/components/chat/chat-surface";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { getRun } from "@/domains/agents/queries";
import { listThreads } from "@/domains/agents/thread";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { RunControls } from "../run-controls";
import { DraftControls } from "../draft-controls";

export const metadata = { title: "Conversation · Polymath" };

/*
 * One conversation, full page. The home lists rows; this is what a row opens.
 *
 * The transcript is the page. Controls under it are the ones that act on this
 * run: follow-up or cancel, and the draft the run produced. Decisions on
 * approvals live in Reviews; that surface owns the waiting-on-you vocabulary
 * and the routes to act.
 */

async function ConversationSurface({ runId }: { runId: string }) {
  await connection();
  const auth = await getAuthContext();
  // A malformed id would reach Postgres as a uuid cast error and 500; the API
  // route answers 404 for it, and this page must answer the same.
  if (!z.string().uuid().safeParse(runId).success) notFound();
  const run = await getRun(auth.workspaceId, runId);
  // Missing and other-workspace are the same answer on purpose (see getRun).
  if (!run) notFound();

  const [threads, drafts] = await Promise.all([
    listThreads(auth.workspaceId, [run.id]),
    draftsForRuns(auth, [run.id]),
  ]);

  const thread = threads.get(run.id) ?? [];
  const unavailable = eveBridgeUnavailableReason();
  // Mirrors the server's own terminal set: a run that has not finished may still
  // produce events, so it streams; anything else is history.
  const finished = ["succeeded", "failed", "cancelled"].includes(run.state);
  // A live run streams when the bridge is up; without it the run still takes a
  // follow-up and a stop through the plain API controls - a waiting run is a
  // conversation, not a dead end.
  const isLive = !finished && !unavailable;

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
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[14px] leading-tight font-medium">{run.objective}</h1>
            <p className="text-muted-foreground truncate text-[11px]">
              Started {timeAgo(run.createdAt)}
              {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            </p>
          </div>
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
              placeholder="Reply to continue…"
              composerLabel="Follow-up message"
              emptyText="This conversation has no messages yet."
              showHeader={false}
              className="min-h-0 flex-1"
            />
          ) : thread.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              This conversation has no messages yet.
            </p>
          ) : (
            <div className="space-y-4">
              {thread.map((entry) =>
                entry.kind === "user" ? (
                  <div key={entry.sequence} className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] leading-6">
                    {entry.text}
                  </div>
                ) : entry.kind === "assistant" ? (
                  <div key={entry.sequence} className="max-w-[72ch] text-[13px] leading-6">
                    <Markdown text={entry.text} />
                  </div>
                ) : entry.kind === "reasoning" ? (
                  // The model's visible rationale, kept from the live stream. A
                  // quiet disclosure, not a transcript body: it is evidence for
                  // the answer above it, not the thing being read.
                  <details key={entry.sequence} className="max-w-[72ch]">
                    <summary className="text-muted-foreground cursor-pointer text-[12px] hover:text-foreground">
                      Show thinking
                    </summary>
                    <p className="text-muted-foreground mt-2 text-[13px] whitespace-pre-wrap">{entry.text}</p>
                  </details>
                ) : (
                  <p key={entry.sequence} className="text-muted-foreground text-[12px]">
                    {entry.text} · {timeAgo(entry.at)}
                  </p>
                ),
              )}
            </div>
          )}

          {run.error ? (
            <p role="alert" className="text-destructive text-[13px]">{run.error}</p>
          ) : null}
          {/* The live composer above already sends messages; the only action it
              lacks is stopping the run. A finished run takes Retry here. */}
          {finished ? (
            <RunControls runId={run.id} finished />
          ) : unavailable ? (
            <RunControls runId={run.id} finished={false} />
          ) : (
            <ChatCancel runId={run.id} />
          )}
          <DraftControls
            runId={run.id}
            draft={drafts.get(run.id) ?? null}
            canSave={(run.state === "succeeded" || run.state === "waiting_input") && thread.some((entry) => entry.kind === "assistant")}
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
