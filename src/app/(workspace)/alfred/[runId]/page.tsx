import { Suspense } from "react";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/markdown";
import { ChatCancel, ChatSurface } from "@/components/chat/chat-surface";
import { MessageFeedback } from "@/components/chat/message-feedback";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { displayTitle } from "@/lib/display-text";
import { getRun, getRunUsage, type RunUsage } from "@/domains/agents/queries";
import { modelById } from "@/domains/agents/models";
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

/*
 * What the run has cost, from its recorded usage events. Every total is
 * labeled "recorded": the recording contract does not guarantee completeness
 * (a step may report no usage, usage without a price, or a dropped bridge
 * write), so even a finished run's figure is what was recorded, not a
 * guaranteed final bill. Missing cost stays missing - never rendered as zero.
 */
function costLabel(usage: RunUsage | null, finished: boolean): string | null {
  if (!usage) return finished ? "no usage recorded" : null;
  if (usage.usd === null) return "cost not recorded";
  const n = Number(usage.usd);
  const usd = Number.isFinite(n) ? (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)) : usage.usd;
  return `$${usd} recorded${finished ? "" : " so far"}`;
}

async function ConversationSurface({ runId }: { runId: string }) {
  await io();
  const auth = await getAuthContext();
  // A malformed id would reach Postgres as a uuid cast error and 500; the API
  // route answers 404 for it, and this page must answer the same.
  if (!z.string().uuid().safeParse(runId).success) notFound();
  const run = await getRun(auth.workspaceId, runId);
  // Missing and other-workspace are the same answer on purpose (see getRun).
  if (!run) notFound();

  const [threads, drafts, usage] = await Promise.all([
    listThreads(auth.workspaceId, [run.id]),
    draftsForRuns(auth, [run.id]),
    getRunUsage(auth.workspaceId, run.id),
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
  // The model's display label, not its provider id — the header speaks product words.
  const modelLabel = run.model ? (modelById(run.model)?.label ?? run.model) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * One compact header, not the destination-sized one: the transcript is
       * the page, and the objective is a label on it. The page header itself
       * stays because app screens always name what they show; everything else
       * about the run is in Details.
       */}
      <header className="border-border bg-background/95 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-[var(--page-width)] items-baseline gap-3 px-6 py-2.5">
          <h1 className="min-w-0 flex-1 truncate text-[14px] leading-snug font-medium">{displayTitle(run.objective)}</h1>
          {/* One meta line, small enough to recede: when it started, how it ended, what it recorded. */}
          <p className="text-muted-foreground shrink-0 text-[11px] whitespace-nowrap">
            {modelLabel ? `${modelLabel} · ` : ""}
            {timeAgo(run.createdAt)}
            {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            {costLabel(usage, finished) ? ` · ${costLabel(usage, finished)}` : null}
          </p>
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
            <div className="mx-auto w-full max-w-[var(--page-width)] space-y-3">
              {thread.map((entry) =>
                entry.kind === "user" ? (
                  // The owner's words stay visible without a slab of chrome: right-aligned,
                  // tinted only enough to separate from the answer, no big bubble.
                  <div key={entry.sequence} className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-[14px] leading-6">
                    {entry.text}
                  </div>
                ) : entry.kind === "assistant" ? (
                  <div key={entry.sequence} className="mx-auto w-full max-w-[var(--page-width)] text-[15px] leading-7">
                    <Markdown text={entry.text} />
                    <MessageFeedback runId={run.id} sequence={entry.sequence} initial={entry.feedback ?? null} />
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
          {/* One quiet action row under the transcript: the live composer above
              already sends messages, so this row only carries what it lacks —
              stop for a live run, retry for a finished one — plus the draft.
              Text actions, not buttons: they share the transcript's edge and
              never read as a second composer. */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
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
          </div>
        </section>
      </div>
    </div>
  );
}

/*
 * A Suspense boundary is required, not decorative: `cacheComponents` refuses to
 * prerender a route that awaits `io()` outside one, and the workspace
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
