import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { explainSessions, explainTurns, flashcardDecks, quizzes } from "@/domains/learning/schema";
import { requireRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { llmFeedback, type LlmFeedbackSurface } from "./schema";

/*
 * Rating a model output, and reading those ratings back. This is the one write
 * path every surface uses (chat replies, runs, quizzes, flashcard decks,
 * Explain It verdicts, artifacts) — see schema.ts for the row and its invariants.
 *
 * The caller names the output; this module proves it exists in the caller's
 * workspace (and, for an Explain It verdict, belongs to the caller), copies
 * what produced it (model, prompt version) off the output row, and upserts the
 * one rating per person per output. A null score clears the rating. A score of
 * 0 is a run's thumbs-down and is refused on every other surface.
 */

export type RatedOutput =
  /** A chat reply, addressed by its run_event sequence (a stored transcript) or its turn id (a live stream). */
  | { surface: "chat"; runId: string; sequence?: number; turnId?: string }
  | { surface: Exclude<LlmFeedbackSurface, "chat">; id: string };

/** The surface where 0 (thumbs-down) is a legal score; schema.ts enforces the same. */
const THUMBS_DOWN_SURFACE: LlmFeedbackSurface = "run";

export type Rating = { score: number; comment: string | null };

const MAX_COMMENT = 1000;

type ResolvedOutput = {
  surface: LlmFeedbackSurface;
  outputId: string;
  model: string | null;
  promptVersion: string | null;
};

/** The assistant message event a chat address points at, or null. */
async function resolveChatReply(
  conn: TxDrizzle | typeof db,
  auth: AuthContext,
  output: Extract<RatedOutput, { surface: "chat" }>,
): Promise<ResolvedOutput | null> {
  // An assistant reply lands as a `message` row (the Eve bridge) or a
  // `message.completed` row (the sessionless reply lane); both render as the
  // answer, so both can be rated. The latest of a turn is the one on screen.
  const reply = or(
    and(eq(runEvents.type, "message"), sql`${runEvents.data}->>'role' = 'assistant'`),
    eq(runEvents.type, "message.completed"),
  );
  const address =
    output.sequence !== undefined
      ? eq(runEvents.sequence, output.sequence)
      : output.turnId !== undefined
        ? sql`${runEvents.data}->>'turnId' = ${output.turnId}`
        : null;
  if (!address) return null;
  const [row] = await conn
    .select({ id: runEvents.id, model: agentRuns.model, profileRevisionId: agentRuns.profileRevisionId })
    .from(runEvents)
    .innerJoin(agentRuns, and(eq(agentRuns.id, runEvents.runId), eq(agentRuns.workspaceId, runEvents.workspaceId)))
    .where(and(eq(runEvents.workspaceId, auth.workspaceId), eq(runEvents.runId, output.runId), address, reply))
    .orderBy(desc(runEvents.sequence))
    .limit(1);
  if (!row) return null;
  return { surface: "chat", outputId: row.id, model: row.model, promptVersion: row.profileRevisionId };
}

async function resolveOutput(
  conn: TxDrizzle | typeof db,
  auth: AuthContext,
  output: RatedOutput,
): Promise<ResolvedOutput | null> {
  if (output.surface === "chat") return resolveChatReply(conn, auth, output);
  const resolved = (row: { model: string | null; promptVersion: string | null } | undefined) =>
    row ? { surface: output.surface, outputId: output.id, model: row.model, promptVersion: row.promptVersion } : null;
  switch (output.surface) {
    case "run": {
      // The run's provenance: its model, and the profile revision it ran under.
      const [row] = await conn
        .select({ model: agentRuns.model, promptVersion: agentRuns.profileRevisionId })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, output.id), eq(agentRuns.workspaceId, auth.workspaceId)))
        .limit(1);
      return resolved(row);
    }
    case "quiz": {
      const [row] = await conn
        .select({ model: quizzes.model, promptVersion: quizzes.promptVersion })
        .from(quizzes)
        .where(and(eq(quizzes.id, output.id), eq(quizzes.workspaceId, auth.workspaceId), eq(quizzes.status, "ready")))
        .limit(1);
      return resolved(row);
    }
    case "flashcards": {
      const [row] = await conn
        .select({ model: flashcardDecks.model, promptVersion: flashcardDecks.promptVersion })
        .from(flashcardDecks)
        .where(and(eq(flashcardDecks.id, output.id), eq(flashcardDecks.workspaceId, auth.workspaceId)))
        .limit(1);
      return resolved(row);
    }
    case "explain": {
      // A verdict exists once the turn is answered; the session is private to
      // the person who sat it, so nobody else can rate its verdicts.
      const [row] = await conn
        .select({ promptVersion: explainSessions.promptVersion })
        .from(explainTurns)
        .innerJoin(
          explainSessions,
          and(eq(explainSessions.id, explainTurns.sessionId), eq(explainSessions.workspaceId, auth.workspaceId)),
        )
        .where(
          and(
            eq(explainTurns.id, output.id),
            eq(explainTurns.workspaceId, auth.workspaceId),
            eq(explainSessions.userId, auth.userId),
            sql`${explainTurns.feedback} is not null`,
          ),
        )
        .limit(1);
      return resolved(row ? { model: null, promptVersion: row.promptVersion } : undefined);
    }
    case "artifact": {
      const [row] = await conn
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, output.id), eq(artifacts.workspaceId, auth.workspaceId)))
        .limit(1);
      return resolved(row ? { model: null, promptVersion: null } : undefined);
    }
  }
}

const outputColumn = {
  chat: "runEventId",
  run: "runId",
  quiz: "quizId",
  flashcards: "flashcardDeckId",
  explain: "explainTurnId",
  artifact: "artifactId",
} as const satisfies Record<LlmFeedbackSurface, keyof typeof llmFeedback.$inferInsert>;

/**
 * Set, change, or clear (score null) the caller's rating of one output.
 * Returns null when the output is not in the caller's reach — a missing
 * output and another workspace's are the same answer.
 */
export async function rateOutput(
  auth: AuthContext,
  input: { output: RatedOutput; score: number | null; comment?: string | null },
): Promise<{ rating: Rating | null } | null> {
  const lowest = input.output.surface === THUMBS_DOWN_SURFACE ? 0 : 1;
  if (input.score !== null && !(Number.isInteger(input.score) && input.score >= lowest && input.score <= 5)) {
    throw new RangeError(`A rating is a whole number from ${lowest} to 5.`);
  }
  const comment = input.comment?.trim() ? input.comment.trim().slice(0, MAX_COMMENT) : null;
  return withTransaction(async (tx) => {
    const output = await resolveOutput(tx, auth, input.output);
    if (!output) return null;
    const mine = and(
      eq(llmFeedback.workspaceId, auth.workspaceId),
      eq(llmFeedback.userId, auth.userId),
      eq(llmFeedback.outputId, output.outputId),
    );

    if (input.score === null) {
      const removed = await tx.delete(llmFeedback).where(mine).returning({ id: llmFeedback.id });
      if (removed.length > 0) {
        await recordAudit(
          auth,
          {
            action: "llm_feedback.cleared",
            subjectType: output.surface,
            subjectId: output.outputId,
            summary: "Cleared a rating",
            metadata: { surface: output.surface },
          },
          tx,
        );
      }
      return { rating: null };
    }

    const now = new Date();
    await tx
      .insert(llmFeedback)
      .values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        surface: output.surface,
        [outputColumn[output.surface]]: output.outputId,
        score: input.score,
        comment,
        model: output.model,
        promptVersion: output.promptVersion,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [llmFeedback.workspaceId, llmFeedback.userId, llmFeedback.outputId],
        // An omitted comment keeps the one already written: re-picking a face
        // must not erase the note that explained it.
        set: {
          score: input.score,
          ...(input.comment === undefined ? {} : { comment }),
          updatedBy: auth.userId,
          updatedAt: now,
          version: sql`${llmFeedback.version} + 1`,
        },
      });
    await recordAudit(
      auth,
      {
        action: "llm_feedback.rated",
        subjectType: output.surface,
        subjectId: output.outputId,
        summary: `Rated a ${output.surface} output ${input.score} of 5`,
        metadata: { surface: output.surface, score: input.score },
      },
      tx,
    );
    const [row] = await tx
      .select({ score: llmFeedback.score, comment: llmFeedback.comment })
      .from(llmFeedback)
      .where(mine);
    return { rating: row ?? null };
  });
}

/** The caller's rating of one non-chat output, or null when they have not rated it. */
export async function ratingOf(
  auth: AuthContext,
  output: Extract<RatedOutput, { id: string }>,
): Promise<Rating | null> {
  const ratings = await ratingsOf(auth, output.surface, [output.id]);
  return ratings.get(output.id) ?? null;
}

/** The caller's ratings for several outputs of one kind, keyed by output id. */
export async function ratingsOf(
  auth: AuthContext,
  surface: Exclude<LlmFeedbackSurface, "chat">,
  ids: string[],
): Promise<Map<string, Rating>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ outputId: llmFeedback.outputId, score: llmFeedback.score, comment: llmFeedback.comment })
    .from(llmFeedback)
    .where(
      and(
        eq(llmFeedback.workspaceId, auth.workspaceId),
        eq(llmFeedback.userId, auth.userId),
        eq(llmFeedback.surface, surface),
        inArray(llmFeedback.outputId, ids),
      ),
    );
  return new Map(rows.map((row) => [row.outputId, { score: row.score, comment: row.comment }]));
}

/** A chat rating as the transcript addresses it: by stored sequence and by turn id. */
export type ChatRating = Rating & { sequence: number; turnId: string | null };

/** The caller's ratings of one run's replies. */
export async function chatRatingsForRun(auth: AuthContext, runId: string): Promise<ChatRating[]> {
  const rows = await db
    .select({
      score: llmFeedback.score,
      comment: llmFeedback.comment,
      sequence: runEvents.sequence,
      turnId: sql<string | null>`${runEvents.data}->>'turnId'`,
    })
    .from(llmFeedback)
    .innerJoin(runEvents, and(eq(runEvents.id, llmFeedback.runEventId), eq(runEvents.workspaceId, auth.workspaceId)))
    .where(
      and(
        eq(llmFeedback.workspaceId, auth.workspaceId),
        eq(llmFeedback.userId, auth.userId),
        eq(runEvents.runId, runId),
      ),
    );
  return rows;
}

export type FeedbackReadoutRow = {
  surface: LlmFeedbackSurface;
  model: string | null;
  promptVersion: string | null;
  /** Everything rated, thumbs-down included. */
  count: number;
  /** Run thumbs-downs (score 0). They are counted here and left out of `average` and `distribution`. */
  thumbsDown: number;
  /** The mean of the graded 1-5 scores; null when nothing in the group is graded. */
  average: number | null;
  /** Graded ratings per score, index 0 = score 1. */
  distribution: [number, number, number, number, number];
};

/**
 * Workspace-wide ratings, one row per surface, model and prompt version — what
 * to improve, at the grain a change is made at. The graded average and the
 * thumbs-down share are separate numbers on purpose: a 0 is "not good" with no
 * grade, so folding it into the mean would read as a very bad grade. An admin
 * read: it aggregates every member's ratings.
 */
export async function feedbackReadout(auth: AuthContext): Promise<FeedbackReadoutRow[]> {
  requireRole(auth, "admin");
  const bucket = (score: number) => sql<number>`count(*) filter (where ${llmFeedback.score} = ${score})::int`;
  const rows = await db
    .select({
      surface: llmFeedback.surface,
      model: llmFeedback.model,
      promptVersion: llmFeedback.promptVersion,
      count: count(),
      thumbsDown: bucket(0),
      average: sql<string | null>`avg(${llmFeedback.score}) filter (where ${llmFeedback.score} > 0)`,
      s1: bucket(1),
      s2: bucket(2),
      s3: bucket(3),
      s4: bucket(4),
      s5: bucket(5),
    })
    .from(llmFeedback)
    .where(eq(llmFeedback.workspaceId, auth.workspaceId))
    .groupBy(llmFeedback.surface, llmFeedback.model, llmFeedback.promptVersion)
    .orderBy(llmFeedback.surface, desc(count()))
    .limit(200);
  return rows.map((row) => ({
    surface: row.surface,
    model: row.model,
    promptVersion: row.promptVersion,
    count: row.count,
    thumbsDown: row.thumbsDown,
    average: row.average === null ? null : Number(row.average),
    distribution: [row.s1, row.s2, row.s3, row.s4, row.s5],
  }));
}

/** The latest notes people left with a rating, so a low average comes with its reasons. An admin read. */
export async function recentFeedbackComments(auth: AuthContext, limit = 20) {
  requireRole(auth, "admin");
  return db
    .select({
      surface: llmFeedback.surface,
      score: llmFeedback.score,
      comment: llmFeedback.comment,
      model: llmFeedback.model,
      promptVersion: llmFeedback.promptVersion,
      at: llmFeedback.updatedAt,
    })
    .from(llmFeedback)
    .where(and(eq(llmFeedback.workspaceId, auth.workspaceId), sql`${llmFeedback.comment} is not null`))
    .orderBy(desc(llmFeedback.updatedAt), desc(llmFeedback.id))
    .limit(limit);
}
