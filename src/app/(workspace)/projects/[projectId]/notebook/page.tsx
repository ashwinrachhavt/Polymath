import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { listGeneratedArtifacts } from "@/domains/knowledge/artifacts";
import {
  getProjectDetail,
  listAttachableDocuments,
  listProjectRuns,
  projectDocumentIds,
} from "@/domains/knowledge/projects";
import { listSources } from "@/domains/knowledge/source-readiness";
import { parseStructuredContent } from "@/domains/knowledge/artifact-content";
import { draftsForRuns, getDraftDetail } from "@/domains/knowledge/studio";
import { artifactNextStep } from "@/domains/knowledge/continuation";
import {
  isNotebookChatObjective,
  lastGroundedAnswer,
  listNotebookChats,
  notebookChatLabels,
} from "@/domains/knowledge/notebook-chat";
import { listThreads, type ThreadEntry } from "@/domains/agents/thread";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { timeAgo } from "@/lib/time";
import { listLinkableRecords, resolveLinkTitles } from "@/app/(workspace)/projects-links";
import { DraftWorkbench } from "../../draft-workbench";
import { PracticePanel } from "./practice-panel";
import { listUnfinishedGenerationJobs } from "@/domains/jobs/queries";
import { LEARNING_JOB_KIND_PREFIX, learningJobSubject } from "@/domains/learning/job-names";
import { getNotebookLearningResults } from "@/domains/learning/notebook-results";
import { listChallenges } from "@/domains/learning/challenges";
import { describeShortfall } from "@/domains/learning/item-count";
import { chatRatingsForRun, ratingOf, ratingsOf } from "@/domains/feedback/ratings";
import { listRunSteps } from "@/domains/agents/queries";
import { LearningResults } from "./learning-results";
import NotebookSurface, { type GeneratedArtifact } from "./notebook-surface";

export const metadata: Metadata = { title: "Notebook · Polymath" };

/*
 * A notebook is a project (NotebookLM parity). This route lives under
 * /projects/<id>/notebook rather than /polymath/notebook/<id> because
 * /polymath/notebook is the notes surface and one URL segment cannot mean two
 * objects.
 *
 * The notebook is the project's home: sources, the grounded conversation, and
 * Studio (generate, research, draft review). A ?draft= id opens the workbench
 * below the conversation; an id that is missing, foreign, or not a Studio
 * artifact just opens no workbench.
 *
 * Conversations persist (ASH-179): every chat is a run bound to this project,
 * listed newest first, and ?chat=<runId> resumes one — streamed live while the
 * run is active, read from the stored thread once it has finished, with its
 * last answer saveable to notes. A ?chat= id that is not a conversation of
 * this notebook selects nothing, same rule as ?draft=.
 */

const FINISHED = ["succeeded", "failed", "cancelled"];

async function NotebookData({
  projectId,
  draftId,
  chatId,
  quizId,
}: {
  projectId: string;
  draftId?: string;
  chatId?: string;
  quizId?: string;
}) {
  await io();
  const auth = await getAuthContext();
  const project = await getProjectDetail(auth, projectId);
  if (!project) notFound();

  /*
   * Everything below the guard is independent of its siblings once the
   * project is in hand, so it rides one wave: each read either starts
   * immediately or chains off the one promise it truly depends on (spec W2 —
   * this chain used to run eight sequential phases).
   */
  const chatsPromise = listNotebookChats(auth, projectId);
  const documentIdsPromise = projectDocumentIds(auth, projectId).then((ids) => ids ?? []);
  const sourcesPromise = documentIdsPromise.then((documentIds) =>
    documentIds.length > 0 ? listSources(auth, { documentIds, limit: 100 }) : [],
  );
  const labelsPromise = chatsPromise.then((chats) =>
    notebookChatLabels(
      auth.workspaceId,
      chats.map((chat) => chat.runId),
    ),
  );
  const chatViewPromise = chatsPromise.then(async (chats) => {
    const activeChat = chatId ? (chats.find((chat) => chat.runId === chatId) ?? null) : null;
    const unavailable = eveBridgeUnavailableReason();
    const activeChatLive = activeChat !== null && !FINISHED.includes(activeChat.state) && unavailable === null;
    const threadPromise: Promise<ThreadEntry[]> =
      activeChat && !activeChatLive
        ? listThreads(auth.workspaceId, [activeChat.runId]).then((threads) => threads.get(activeChat.runId) ?? [])
        : Promise.resolve([]);
    const [activeThread, lastAnswer, activeSteps, activeRatings] = await Promise.all([
      threadPromise,
      activeChat ? lastGroundedAnswer(auth, activeChat.runId) : Promise.resolve(null),
      activeChatLive ? listRunSteps(auth.workspaceId, activeChat.runId) : Promise.resolve([]),
      activeChat ? chatRatingsForRun(auth, activeChat.runId) : Promise.resolve([]),
    ]);
    return { activeChat, activeChatLive, activeThread, lastAnswer, activeSteps, activeRatings };
  });

  // Artifacts pinned to this notebook's documents, with their stored structure.
  const generatedPromise = documentIdsPromise.then((documentIds) =>
    listGeneratedArtifacts(auth.workspaceId, documentIds),
  );
  const resultsPromise = documentIdsPromise.then((documentIds) =>
    getNotebookLearningResults(auth, projectId, { documentIds, quizId }),
  );
  // Practice exercises (Predict, Bug Hunt) belong beside the generated quiz and
  // deck; one read, started with the rest of the wave.
  const challengesPromise = listChallenges(auth, projectId);
  // The Studio Runs panel lists generation/research runs. A conversation is a
  // run too, but it belongs to the chat's own history, not this panel.
  const runsPromise = listProjectRuns(auth, projectId).then((runs) =>
    runs.filter((run) => !isNotebookChatObjective(run.objective)),
  );
  const runDraftsPromise = runsPromise.then((runs) =>
    draftsForRuns(
      auth,
      runs.map((run) => run.id),
    ),
  );
  const workbenchPromise = (draftId ? getDraftDetail(auth, draftId) : Promise.resolve(null)).then(
    async (draftDetail) =>
      draftDetail
        ? {
            draftDetail,
            linkTitles: await resolveLinkTitles(auth, draftDetail.links),
            linkable: await listLinkableRecords(auth),
          }
        : { draftDetail: null, linkTitles: {}, linkable: null },
  );

  const [
    sources,
    vault,
    chats,
    labels,
    chatView,
    generatedRows,
    runs,
    runDrafts,
    workbench,
    learning,
    challenges,
    learningJobs,
  ] = await Promise.all([
    sourcesPromise,
    listAttachableDocuments(auth),
    chatsPromise,
    labelsPromise,
    chatViewPromise,
    generatedPromise,
    runsPromise,
    runDraftsPromise,
    workbenchPromise,
    resultsPromise,
    challengesPromise,
    listUnfinishedGenerationJobs(auth, {
      kindPrefix: LEARNING_JOB_KIND_PREFIX,
      subject: learningJobSubject.notebook(projectId),
    }),
  ]);
  const { activeChat, activeChatLive, activeThread, lastAnswer, activeSteps, activeRatings } = chatView;
  const { draftDetail, linkTitles, linkable } = workbench;
  const [quizFeedback, deckFeedback, explainRatings] = await Promise.all([
    learning.quiz ? ratingOf(auth, { surface: "quiz", id: learning.quiz.id }) : null,
    learning.deck ? ratingOf(auth, { surface: "flashcards", id: learning.deck.id }) : null,
    ratingsOf(
      auth,
      "explain",
      (learning.explain?.turns ?? []).map((turn) => turn.id),
    ),
  ]);

  const generated: GeneratedArtifact[] = generatedRows.map((row) => ({
    artifactId: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    // Only deck and infographic rows have structure; a report returns null and
    // renders as a title, which is the honest shape for this pane.
    structured: parseStructuredContent(row.kind, row.versionContent),
  }));

  return (
    <>
      <PageHeader title={project.title} />
      <NotebookSurface
        notebook={{ projectId: project.id, title: project.title }}
        sources={sources}
        artifacts={generated}
        vault={vault.map((doc) => ({ id: doc.id, title: doc.title }))}
        chats={chats.map((chat) => ({
          runId: chat.runId,
          state: chat.state,
          label: labels.get(chat.runId) ?? "New conversation",
          ago: timeAgo(chat.createdAt),
        }))}
        activeChat={
          activeChat
            ? {
                runId: activeChat.runId,
                live: activeChatLive,
                thread: activeThread.map((entry) => ({
                  kind: entry.kind,
                  text: entry.text,
                  ago: timeAgo(entry.at),
                  sequence: entry.sequence,
                })),
                steps: activeSteps,
                ratings: activeRatings,
              }
            : null
        }
        lastAnswer={lastAnswer}
        runs={runs.map((run) => ({ id: run.id, state: run.state, objective: run.objective }))}
        runDrafts={Object.fromEntries(runDrafts)}
        learningJobs={learningJobs}
        results={
          <>
            <PracticePanel
              projectId={project.id}
              documentIds={sources
                .filter((source) => source.readiness === "ready")
                .slice(0, 8)
                .map((source) => source.documentId)}
              items={challenges.map(({ createdAt, ...challenge }) => ({ ...challenge, ago: timeAgo(createdAt) }))}
            />
            <LearningResults
              projectId={project.id}
              initiallyOpen={quizId && learning.quiz?.id === quizId ? "quiz" : null}
              results={{
                quiz: learning.quiz && {
                  id: learning.quiz.id,
                  title: learning.quiz.title,
                  ago: timeAgo(learning.quiz.createdAt),
                  questionCount: learning.quiz.questions.length,
                  note: describeShortfall({
                    made: learning.quiz.questions.length,
                    requested: learning.quiz.requested,
                    stoppedBy: learning.quiz.stoppedBy,
                  }),
                  quiz: learning.quiz,
                  rating: quizFeedback,
                },
                deck: learning.deck && {
                  id: learning.deck.id,
                  title: learning.deck.title,
                  ago: timeAgo(learning.deck.createdAt),
                  cardCount: learning.deck.cardCount,
                  note: describeShortfall({
                    made: learning.deck.cardCount,
                    requested: learning.deck.requested,
                    stoppedBy: learning.deck.stoppedBy,
                  }),
                  dueCards: learning.deck.cards,
                  rating: deckFeedback,
                },
                explain: learning.explain && {
                  id: learning.explain.id,
                  title: learning.explain.title,
                  ago: timeAgo(learning.explain.createdAt),
                  session: learning.explain,
                  ratings: Object.fromEntries(explainRatings),
                },
              }}
            />
          </>
        }
      />
      {draftDetail && linkable ? (
        <section aria-label="Draft workbench" className="page-content mt-6">
          <DraftWorkbench
            suggestedNextStep={artifactNextStep(draftDetail.artifact.status, draftDetail.pendingRevisions)}
            artifact={draftDetail.artifact}
            versions={draftDetail.versions}
            text={draftDetail.text}
            sources={draftDetail.sources}
            links={draftDetail.links}
            linkTitles={linkTitles}
            linkable={linkable}
          />
        </section>
      ) : null}
    </>
  );
}

export default function NotebookPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ draft?: string; chat?: string; quiz?: string }>;
}) {
  // Both promises are unwrapped inside the boundary (the notes page's
  // pattern): awaiting searchParams — or making this page component async —
  // outside Suspense made every client-side navigation to this route
  // non-instant; Next logged "encountered URL data during prerendering or a
  // navigation".
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <NotebookSearchParams params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function NotebookSearchParams({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ draft?: string; chat?: string; quiz?: string }>;
}) {
  const [{ projectId }, search] = await Promise.all([params, searchParams]);
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <NotebookData projectId={projectId} draftId={search.draft} chatId={search.chat} quizId={search.quiz} />
    </Suspense>
  );
}
