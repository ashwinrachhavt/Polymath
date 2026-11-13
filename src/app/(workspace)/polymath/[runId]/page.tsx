import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { z } from "zod";
import { Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/markdown";
import { inline } from "@/components/markdown-inline";
import { ChatSurface } from "@/components/chat/chat-surface";
import { AgentSteps, type StepRow } from "@/components/chat/agent-steps";
import { reasoningStepRow, toolStepRow } from "@/components/chat/step-rows";
import { OutputRating } from "@/components/feedback/output-rating";
import { chatRatingsForRun, ratingOf } from "@/domains/feedback/ratings";
import { getAuthContext } from "@/lib/auth";
import { timeAgo } from "@/lib/time";
import { displayTitle } from "@/lib/display-text";
import {
  getRun,
  getRunUsage,
  listRecentRuns,
  listRunMessageIds,
  listRunSteps,
  type RunUsage,
} from "@/domains/agents/queries";
import { getOpenQuestion, getRunAgent, listRunPendingProposals } from "@/domains/agents/run-context";
import { getRunCritique } from "@/domains/agents/run-reviews";
import { modelById } from "@/domains/agents/models";
import { listThreads } from "@/domains/agents/thread";
import { threadBlocks } from "@/domains/agents/stream-contract";
import { stripMentionContext, hasMentionContext } from "@/components/chat/mention-context";
import { draftsForRuns } from "@/domains/knowledge/studio";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { RunControls } from "../run-controls";
import { RunReview } from "./run-review";
import { DraftControls } from "../draft-controls";
import { groupHistory, type HistoryRow } from "../history";
import { HistoryMenu, historyChipClass } from "../history-menu";
import type { InterruptCard } from "@/components/chat/confirmation";
import { answerRunQuestion } from "./question-actions";

export const metadata = { title: "Conversation · Polymath" };

/*
 * One conversation, full page. The home lists rows; this is what a row opens.
 *
 * The transcript is the page. The only control under it is retry, and the
 * draft the run produced. Decisions on approvals live in Reviews; that surface
 * owns the waiting-on-you vocabulary and the routes to act.
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

  const [
    history,
    threads,
    drafts,
    usage,
    critique,
    agent,
    openQuestion,
    pendingProposals,
    messageIds,
    steps,
    ratings,
    runRating,
  ] = await Promise.all([
    // The history menu is the same conversation list the idle home renders
    // (history.ts feeds both), so it excludes onboarding runs for the same
    // reason: machinery the person never typed is not a conversation.
    listRecentRuns(auth.workspaceId, 50, { excludeOnboarding: true }),
    listThreads(auth.workspaceId, [run.id]),
    draftsForRuns(auth, [run.id]),
    getRunUsage(auth.workspaceId, run.id),
    getRunCritique(auth.workspaceId, run.id),
    getRunAgent(auth.workspaceId, run.id),
    getOpenQuestion(auth.workspaceId, run.id),
    listRunPendingProposals(auth.workspaceId, run.id),
    listRunMessageIds(auth.workspaceId, run.id),
    listRunSteps(auth.workspaceId, run.id),
    chatRatingsForRun(auth, run.id),
    ratingOf(auth, { surface: "run", id: run.id }),
  ]);
  const historyGroups = groupHistory(
    history.map((row): HistoryRow => ({
      id: row.id,
      title: displayTitle(stripMentionContext(row.objective)) || "Untitled conversation",
      href: `/polymath/${row.id}`,
      at: row.createdAt,
    })),
  );

  const thread = threads.get(run.id) ?? [];
  // A user entry may carry the mention context block the model reads; the
  // stored snapshot renders only the words the person typed.
  const visibleThread = thread.map((entry) =>
    entry.kind === "user" && hasMentionContext(entry.text)
      ? { ...entry, text: stripMentionContext(entry.text) }
      : entry,
  );
  /*
   * Pair rendered blocks to stored messages by index, and only when the
   * counts match (plan Task 8): the Zoe bridge mirrors rendered messages
   * into `messages`, but a guarded mirror can lag or fail, and a mismatched
   * pairing would attach a comment to the wrong message. threadBlocks skips
   * empty texts, so the pairing runs over the same rendered subsequence the
   * block list will show; a null messageId hides the comment control rather
   * than guess.
   */
  const stored = visibleThread.flatMap((entry) =>
    entry.kind === "user" || entry.kind === "assistant"
      ? [{ sequence: entry.sequence, role: entry.kind, text: entry.text, turnId: entry.turnId ?? null }]
      : [],
  );
  const rendered = stored.filter((message) => message.text.length > 0);
  const pairedIds = messageIds.length === rendered.length ? messageIds : null;
  let nextId = 0;
  const pairedStored = stored.map((message) => {
    if (!pairedIds || message.text.length === 0) return { ...message, messageId: null };
    return { ...message, messageId: pairedIds[nextId++] ?? null };
  });
  const unavailable = eveBridgeUnavailableReason();
  // Mirrors the server's own terminal set: a run that has not finished may still
  // produce events, so it streams; anything else is history.
  const finished = ["succeeded", "failed", "cancelled"].includes(run.state);
  // A live run streams when the bridge is up and takes its next message through
  // the composer; without the bridge there is no composer, so nothing here can
  // continue the run.
  const isLive = !finished && !unavailable;
  // The model's display label, not its provider id — the header speaks product words.
  const modelLabel = run.model ? (modelById(run.model)?.label ?? run.model) : null;

  /*
   * The stored transcript's step cards, one per model turn: the turn's visible
   * reasoning and its recorded tool calls, shown above the turn's first entry
   * (the same placement the live transcript uses). A turn whose steps have no
   * entry to sit above (it failed before answering) is listed at the end.
   */
  const stepsByTurn = new Map<string, StepRow[]>();
  const addStep = (turnId: string, row: StepRow) => stepsByTurn.set(turnId, [...(stepsByTurn.get(turnId) ?? []), row]);
  for (const entry of visibleThread) {
    if (entry.kind === "reasoning" && entry.turnId)
      addStep(entry.turnId, reasoningStepRow(`reasoning:${entry.sequence}`, entry.text, true));
  }
  for (const step of steps) addStep(step.turnId, toolStepRow(step));
  // The sequence of each turn's first assistant or reasoning entry: its card's anchor.
  const anchorOfTurn = new Map<string, number>();
  for (const entry of visibleThread) {
    if ((entry.kind === "assistant" || entry.kind === "reasoning") && entry.turnId && !anchorOfTurn.has(entry.turnId))
      anchorOfTurn.set(entry.turnId, entry.sequence);
  }
  const unanchoredSteps = [...stepsByTurn].filter(([turnId]) => !anchorOfTurn.has(turnId));
  const stepsBefore = (entry: (typeof visibleThread)[number]) => {
    if (!entry.turnId || anchorOfTurn.get(entry.turnId) !== entry.sequence) return null;
    const rows = stepsByTurn.get(entry.turnId);
    return rows ? <AgentSteps key={`steps:${entry.turnId}`} steps={rows} active={false} /> : null;
  };
  const ratingOfSequence = (sequence: number) => {
    const rating = ratings.find((entry) => entry.sequence === sequence);
    return rating ? { score: rating.score, comment: rating.comment } : null;
  };

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
            body: openQuestion.context ? `${openQuestion.question}\n\n${openQuestion.context}` : openQuestion.question,
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
        <div className="mx-auto flex h-12 w-full max-w-[var(--measure-prose)] items-center gap-1 px-4 md:px-0">
          <HistoryMenu groups={historyGroups} label="Chats" />
          <Link href="/polymath" className={historyChipClass}>
            <Plus aria-hidden className="size-3.5 shrink-0" />
            <span>New chat</span>
          </Link>
          <h1 className="text-muted-foreground ml-auto min-w-0 truncate text-label leading-snug font-normal">
            {displayTitle(stripMentionContext(run.objective))}
          </h1>
          {/* One meta line, small enough to recede: when it started, how it ended, what it recorded. */}
          <p className="text-muted-foreground/80 hidden shrink-0 text-data whitespace-nowrap sm:block">
            {modelLabel ? `${modelLabel} · ` : ""}
            {timeAgo(run.createdAt)}
            {run.endedAt ? ` · ended ${timeAgo(run.endedAt)}` : null}
            {costLabel(usage, finished) ? ` · ${costLabel(usage, finished)}` : null}
          </p>
        </div>
      </header>

      {/*
       * One centered reading column for the whole surface: the header row, the
       * transcript and the composer all share the shared --measure-prose
       * reading measure, so nothing reads as anchored to a different axis.
       * `.page-content` only supplies the page's gutters; the width is set here.
       */}
      <div className="page-content flex min-h-0 flex-1 flex-col gap-4">
        <section
          aria-label="Conversation"
          className="mx-auto flex min-h-0 w-full max-w-[var(--measure-prose)] flex-1 flex-col gap-3 py-4"
        >
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
              initial={threadBlocks(pairedStored)}
              initialSteps={steps}
              ratings={ratings}
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
              {/*
               * A live run without the bridge has no composer and no follow-up
               * field on purpose: the messages endpoint answers 503 in that
               * state, so a control here would promise a reply it cannot send.
               * Say why the page is quiet instead of leaving a dead end.
               */}
              {!finished && unavailable ? (
                <p className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-body-dense text-muted-foreground">
                  This conversation cannot continue until the agent bridge is configured on this deployment. The run is
                  still recorded, and its transcript is below.
                </p>
              ) : null}
              {visibleThread.length === 0 ? (
                <p className="text-muted-foreground text-body-dense">This conversation has no messages yet.</p>
              ) : null}
              {visibleThread.map((entry) => [
                stepsBefore(entry),
                entry.kind === "user" ? (
                  // The owner's words stay visible without a slab of chrome: right-aligned,
                  // tinted only enough to separate from the answer, no big bubble.
                  <div
                    key={entry.sequence}
                    className="bg-muted/60 ml-auto w-fit max-w-[75%] rounded-md px-2.5 py-1 text-body leading-6"
                  >
                    {inline(entry.text)}
                  </div>
                ) : entry.kind === "assistant" ? (
                  <div key={entry.sequence} className="prose-reading w-full font-[family-name:var(--font-reading)]">
                    <Markdown text={entry.text} />
                    <OutputRating
                      output={{ surface: "chat", runId: run.id, sequence: entry.sequence }}
                      initial={ratingOfSequence(entry.sequence)}
                      className="mt-1"
                    />
                  </div>
                ) : entry.kind === "reasoning" ? (
                  // A turn's reasoning rides its step card (above). Reasoning
                  // stored without a turn has no card to join, so it gets one.
                  entry.turnId ? null : (
                    <AgentSteps
                      key={entry.sequence}
                      active={false}
                      steps={[reasoningStepRow(`reasoning:${entry.sequence}`, entry.text, true)]}
                    />
                  )
                ) : (
                  <p key={entry.sequence} className="text-muted-foreground text-label">
                    {entry.text} · {timeAgo(entry.at)}
                  </p>
                ),
              ])}
              {unanchoredSteps.map(([turnId, rows]) => (
                <AgentSteps key={`steps:${turnId}`} steps={rows} active={false} />
              ))}
            </div>
          )}

          {run.error ? (
            <p role="alert" className="text-destructive text-body-dense">
              {run.error}
            </p>
          ) : null}
          {/* One quiet action row under the transcript, rendered only when it
              has something to carry: retry for a finished run, and the draft.
              A live run needs no controls here — the composer above sends the
              next message, and a stop control that could not settle the run
              only took space. Text actions, not buttons: they share the
              transcript's edge and never read as a second composer. */}
          {finished || (drafts.get(run.id) ?? null) ? (
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
              {finished ? <RunControls runId={run.id} /> : null}
              <DraftControls draft={drafts.get(run.id) ?? null} />
            </div>
          ) : null}

          {/* The run's review block: the agent's self-critique proposal and the
              operator's verdict. Finished runs only - a live run's review would
              be a verdict on a run that has not finished being itself. An empty
              critique renders nothing, per the spec. */}
          {finished ? <RunReview runId={run.id} critique={critique} initialRating={runRating} /> : null}
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
