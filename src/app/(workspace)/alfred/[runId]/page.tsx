import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { z } from "zod";
import { Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/markdown";
import { inline } from "@/components/markdown-inline";
import { ChatCancel, ChatSurface } from "@/components/chat/chat-surface";
import { ChainOfThought } from "@/components/chat/chain-of-thought";
import { MessageFeedback } from "@/components/chat/message-feedback";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { displayTitle } from "@/lib/display-text";
import { getRun, getRunUsage, listRecentRuns, type RunUsage } from "@/domains/agents/queries";
import { getOpenQuestion, getRunAgent, listRunPendingProposals } from "@/domains/agents/run-context";
import { getRunReviews } from "@/domains/agents/run-reviews";
import { modelById } from "@/domains/agents/models";
import { listThreads } from "@/domains/agents/thread";
import { threadBlocks } from "@/domains/agents/stream-contract";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { RunControls } from "../run-controls";
import { RunReview } from "./run-review";
import { DraftControls } from "../draft-controls";
import { groupHistory, type HistoryRow } from "../history";
import { HistoryMenu } from "../history-menu";
import type { InterruptCard } from "@/components/chat/confirmation";
import { answerRunQuestion } from "./question-actions";

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

  const [history, threads, drafts, usage, reviews, agent, openQuestion, pendingProposals] = await Promise.all([
    listRecentRuns(auth.workspaceId, 50),
    listThreads(auth.workspaceId, [run.id]),
    draftsForRuns(auth, [run.id]),
    getRunUsage(auth.workspaceId, run.id),
    getRunReviews(auth.workspaceId, run.id),
    getRunAgent(auth.workspaceId, run.id),
    getOpenQuestion(auth.workspaceId, run.id),
    listRunPendingProposals(auth.workspaceId, run.id),
  ]);
  const historyGroups = groupHistory(
    history.map(
      (row): HistoryRow => ({
        id: row.id,
        title: displayTitle(row.objective) || "Untitled conversation",
        href: `/alfred/${row.id}`,
        at: row.createdAt,
      }),
    ),
  );

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

  /*
   * What the run is waiting on, if anything. A question is answered right here
   * because answering is a sentence. An approval is decided here too when the
   * surface can reach the decision; either way the card links to the full
   * review, which is where the payload and its risk class are shown.
   *
   * A finished run shows neither: a question or a proposal that outlived its run
   * is history, and offering to answer it would promise a continuation the run
   * cannot make.
   */
  const firstProposal = pendingProposals[0];
  const interrupt: InterruptCard | null =
    !isLive || finished
      ? null
      : openQuestion
        ? {
            id: openQuestion.id,
            kind: "question",
            title: "The agent needs an answer",
            body: openQuestion.context
              ? `${openQuestion.question}\n\n${openQuestion.context}`
              : openQuestion.question,
            ...(openQuestion.options.length > 0 ? { options: openQuestion.options } : {}),
          }
        : firstProposal
          ? {
              id: firstProposal.id,
              kind: "approval",
              title: firstProposal.title,
              body: firstProposal.expectedEffect,
              href: "/reviews",
            }
          : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
       * The bar holds the way back to the other conversations and the way to a
       * new one; the conversation itself is the page. The objective is the h1
       * because app screens always name what they show, but it stays at label
       * size on the far side of the row so it labels the transcript instead of
       * competing with it.
       */}
      <header className="bg-background/95 sticky top-0 z-10 backdrop-blur">
        <div className="mx-auto flex h-12 w-full max-w-3xl items-center gap-1 px-4 md:px-0">
          <HistoryMenu groups={historyGroups} label="Chats" />
          <Link
            href="/alfred"
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2"
          >
            <Plus aria-hidden className="size-3.5 shrink-0" />
            <span>New chat</span>
          </Link>
          <h1 className="text-muted-foreground ml-auto min-w-0 truncate text-[12px] leading-snug font-normal">
            {displayTitle(run.objective)}
          </h1>
          {/* One meta line, small enough to recede: when it started, how it ended, what it recorded. */}
          <p className="text-muted-foreground/80 hidden shrink-0 text-[11px] whitespace-nowrap sm:block">
            {modelLabel ? `${modelLabel} · ` : ""}
            {timeAgo(run.createdAt)}
            {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            {costLabel(usage, finished) ? ` · ${costLabel(usage, finished)}` : null}
          </p>
        </div>
      </header>

      {/*
       * One centered reading column for the whole surface: the header row, the
       * transcript and the composer all share the same 768px measure, so nothing
       * reads as anchored to a different axis. `.page-content` only supplies the
       * page's gutters; the width is set here.
       */}
      <div className="page-content flex min-h-0 flex-1 flex-col gap-4">
        <section aria-label="Conversation" className="reading-page mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3">
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
              initial={threadBlocks(
                thread.flatMap((entry) =>
                  entry.kind === "user" || entry.kind === "assistant"
                    ? [{ sequence: entry.sequence, role: entry.kind, text: entry.text, turnId: entry.turnId ?? null }]
                    : [],
                ),
              )}
              placeholder="Reply to continue…"
              composerLabel="Follow-up message"
              emptyText="This conversation has no messages yet."
              showHeader={false}
              className="min-h-0 flex-1"
              {...(agent ? { agent } : {})}
              interrupt={interrupt}
              onInterruptAnswer={
                openQuestion
                  ? async (answer) => {
                      const result = await answerRunQuestion({
                        runId: run.id,
                        questionId: openQuestion.id,
                        answer,
                      });
                      return result.ok ? { ok: true } : { ok: false, message: result.message };
                    }
                  : undefined
              }
            />
          ) : (
            <div className="w-full space-y-3">
              {thread.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">This conversation has no messages yet.</p>
              ) : null}
              {thread.map((entry) =>
                entry.kind === "user" ? (
                  // The owner's words stay visible without a slab of chrome: right-aligned,
                  // tinted only enough to separate from the answer, no big bubble.
                  <div key={entry.sequence} className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-[14px] leading-6">
                    {inline(entry.text)}
                  </div>
                ) : entry.kind === "assistant" ? (
                  <div key={entry.sequence} className="prose-reading w-full font-[family-name:var(--font-reading)]">
                    <Markdown text={entry.text} />
                    <MessageFeedback runId={run.id} sequence={entry.sequence} initial={entry.feedback ?? null} />
                  </div>
                ) : entry.kind === "reasoning" ? (
                  // The model's visible rationale, kept from the stored thread.
                  // One collapsed block for the whole transcript rather than a
                  // pill per entry: the working is evidence for the answer, not
                  // a second transcript interleaved with it.
                  <ChainOfThought
                    key={entry.sequence}
                    streaming={false}
                    steps={[{ id: String(entry.sequence), kind: "reasoning", label: "Thought process", text: entry.text, status: "complete" }]}
                  />
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

          {/* The run's review block: the agent's self-critique proposal and the
              operator's verdict. Finished runs only - a live run's review would
              be a verdict on a run that has not finished being itself. An empty
              critique renders nothing, per the spec. */}
          {finished ? (
            <RunReview
              runId={run.id}
              initial={{
                critique: reviews.critique
                  ? {
                      gotWrong: reviews.critique.gotWrong,
                      wasThin: reviews.critique.wasThin,
                      wouldDoDifferently: reviews.critique.wouldDoDifferently,
                      dismissedAt: reviews.critique.dismissedAt,
                    }
                  : null,
                feedback: reviews.feedback
                  ? { verdict: reviews.feedback.verdict, reasons: reviews.feedback.reasons, note: reviews.feedback.note }
                  : null,
              }}
            />
          ) : null}
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
