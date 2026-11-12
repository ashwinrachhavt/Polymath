import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { submitGenerationJob } from "@/domains/jobs/commands";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure, type GenerationJobView } from "@/domains/jobs/state";
import { FlashcardError, generateFlashcardDeck } from "./flashcards";
import { GENERATION_COPY, generateQuiz, loadCurrentQuizSources, QuizGenerationError } from "./generate-quiz";
import { learningJobKind, type LearningJobKind } from "./job-names";
import { type GenerationOutcome, MAX_ITEM_COUNT, MAX_LEARNING_SOURCES, MIN_ITEM_COUNT } from "./item-count";

/*
 * Quizzes and flashcard decks as generation jobs: the request names its
 * sources and returns, and these runners do the model work later. Each
 * surface that makes one (Learn, the inbox, a Notebook, a document's quiz
 * page) submits the same input, so they cannot drift apart.
 */

const inputSchema = z.object({
  /** The Notebook the result belongs to; absent for one made on Learn or in the inbox. */
  notebookId: z.uuid().optional(),
  /** Library documents, already resolved and in the order picked. */
  documentIds: z.array(z.uuid()).min(1).max(MAX_LEARNING_SOURCES),
  count: z.number().int().min(MIN_ITEM_COUNT).max(MAX_ITEM_COUNT).optional(),
});

type LearningJobInput = z.infer<typeof inputSchema>;

/**
 * Accepts a quiz or deck to be made later, and returns its job at once.
 *
 * The sources are checked first, so a request that could never be made is
 * refused here (QuizGenerationError: not in the workspace, still being read)
 * instead of failing later out of sight. `created` is false for a repeated
 * `idempotencyKey`; the caller starts the work only when it is true.
 */
export async function acceptLearningJob(
  auth: AuthContext,
  request: {
    kind: LearningJobKind;
    documentIds: string[];
    count?: number;
    notebookId?: string;
    /** Which surface's list the job shows in (learningJobSubject in job-names.ts); omit for Learn's own. */
    subject?: string;
    idempotencyKey: string;
  },
): Promise<{ job: GenerationJobView; created: boolean }> {
  const sources = await loadCurrentQuizSources(auth, request.documentIds);
  const input: LearningJobInput = {
    notebookId: request.notebookId,
    documentIds: request.documentIds,
    count: request.count,
  };
  return submitGenerationJob(auth, {
    kind: learningJobKind(request.kind),
    subject: request.subject,
    idempotencyKey: request.idempotencyKey,
    title: learningJobTitle(
      request.kind,
      sources.map((source) => source.title),
    ),
    input,
  });
}

const MAX_TITLE_SOURCE_CHARS = 60;

/** What the job's row says while it is being made. */
function learningJobTitle(kind: LearningJobKind, sourceTitles: string[]): string {
  const [first = "Untitled", ...rest] = sourceTitles;
  // A filed capture's title can be its whole first paragraph; the row and the notice need a name, not the text.
  const name = first.length > MAX_TITLE_SOURCE_CHARS ? `${first.slice(0, MAX_TITLE_SOURCE_CHARS).trimEnd()}…` : first;
  const sources = rest.length === 0 ? name : `${name} + ${rest.length} more`;
  return kind === "quiz" ? `Quiz: ${sources}` : `Flashcards: ${sources}`;
}

/** A result that came out short of its request, in one sentence; null when it did not. */
function shortfallNotice(
  noun: string,
  run: { made: number; requested: number; stoppedBy: GenerationOutcome | "in_progress" },
): string | null {
  if (run.stoppedBy === "in_progress" || run.made >= run.requested) return null;
  if (run.stoppedBy === "batch_failed") {
    return `Made ${run.made} of ${run.requested} ${noun} before a batch failed. Make them again for more.`;
  }
  return `Made ${run.made} of ${run.requested} ${noun}; the sources support no more.`;
}

function parse(input: unknown): LearningJobInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error("malformed learning job input");
  return parsed.data;
}

const makeQuiz: GenerationJobRunner = async (auth, raw, run) => {
  const input = parse(raw);
  await run.progress("Writing questions");
  try {
    const quiz = await generateQuiz(auth, {
      notebookId: input.notebookId,
      documentId: input.documentIds[0],
      documentIds: input.documentIds,
      questionCount: input.count,
      idempotencyKey: run.generationKey,
    });
    return {
      href: input.notebookId ? `/projects/${input.notebookId}/notebook` : `/learn/quizzes/${quiz.quizId}`,
      notice: shortfallNotice("questions", {
        made: quiz.questionCount,
        requested: quiz.requested,
        stoppedBy: quiz.stoppedBy,
      }),
    };
  } catch (cause) {
    if (cause instanceof QuizGenerationError) throw new GenerationJobFailure(GENERATION_COPY[cause.code]);
    throw cause;
  }
};

const makeFlashcards: GenerationJobRunner = async (auth, raw, run) => {
  const input = parse(raw);
  await run.progress("Writing cards");
  try {
    const deck = await generateFlashcardDeck(auth, {
      notebookId: input.notebookId,
      documentIds: input.documentIds,
      cardCount: input.count,
      idempotencyKey: run.generationKey,
    });
    return {
      href: input.notebookId ? `/projects/${input.notebookId}/notebook` : `/learn/decks/${deck.deckId}`,
      notice: shortfallNotice("flashcards", {
        made: deck.cardCount,
        requested: deck.requested,
        stoppedBy: deck.stoppedBy,
      }),
    };
  } catch (cause) {
    if (cause instanceof FlashcardError) throw new GenerationJobFailure(cause.message);
    throw cause;
  }
};

export const learningJobRunners: Record<string, GenerationJobRunner> = {
  [learningJobKind("quiz")]: makeQuiz,
  [learningJobKind("flashcards")]: makeFlashcards,
};
