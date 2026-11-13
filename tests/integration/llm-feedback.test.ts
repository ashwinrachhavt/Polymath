import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { memberships, users } from "@/domains/identity/schema";
import { explainSessions, explainTurns, flashcardDecks, quizzes } from "@/domains/learning/schema";
import { llmFeedback } from "@/domains/feedback/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import { seedNotebook, seedReadDocument } from "../helpers/learning-fixtures";

/*
 * llm_feedback is the one store for 1-5 ratings of model output. These cases
 * pin its contract against a real database: one rating per person per output
 * (a re-pick updates, a null clears), provenance copied off the output rather
 * than taken from the caller, workspace and ownership scoping, and the
 * readout's grouping and distribution.
 */

const handle = makeTestDb();
let ratings: typeof import("@/domains/feedback/ratings");
let owner: AuthContext;
let member: AuthContext;
let stranger: AuthContext;
let runId: string;
let quizId: string;
let deckId: string;
let explainTurnId: string;
const turnId = "turn-abc";

beforeAll(async () => {
  const { db } = handle;
  ratings = await import("@/domains/feedback/ratings");
  const seeded = await seedWorkspace(db, `llm-feedback-${Date.now()}`);
  owner = ownerAuth(seeded.userId, seeded.workspaceId);
  const [memberUser] = await db
    .insert(users)
    .values({ clerkUserId: `tw_member_${Date.now()}` })
    .returning();
  await db
    .insert(memberships)
    .values({ workspaceId: seeded.workspaceId, userId: memberUser.id, role: "member", status: "active" });
  member = { userId: memberUser.id, workspaceId: seeded.workspaceId, role: "member" };
  const other = await seedWorkspace(db, `llm-feedback-other-${Date.now()}`);
  stranger = ownerAuth(other.userId, other.workspaceId);

  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId: owner.workspaceId, name: "polymath", createdBy: owner.userId, updatedBy: owner.userId })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId: owner.workspaceId,
      agentProfileId: profile.id,
      objective: "rating test run",
      policySnapshot: {},
      state: "succeeded",
      model: "openai/gpt-test",
      createdBy: owner.userId,
      updatedBy: owner.userId,
    })
    .returning();
  runId = run.id;
  await db.insert(runEvents).values([
    { workspaceId: owner.workspaceId, runId, sequence: 1, type: "message", data: { role: "user", content: "Why?" } },
    {
      workspaceId: owner.workspaceId,
      runId,
      sequence: 2,
      type: "message",
      data: { role: "assistant", content: "Because.", turnId },
    },
  ]);

  const doc = await seedReadDocument(db, ownerAuth(owner.userId, owner.workspaceId), "Source text for a quiz.");
  const [quiz] = await db
    .insert(quizzes)
    .values({
      workspaceId: owner.workspaceId,
      documentId: doc.documentId,
      sourceExtractionId: doc.extractionId,
      title: "Quiz",
      status: "ready",
      questionCount: 3,
      model: "openrouter:openai/gpt-4o-mini",
      promptVersion: "learn-quiz@7",
    })
    .returning();
  quizId = quiz.id;
  const [deck] = await db
    .insert(flashcardDecks)
    .values({
      workspaceId: owner.workspaceId,
      title: "Deck",
      sourceManifest: [],
      generationKey: `deck-${Date.now()}`,
      model: "openrouter:deck-model",
      promptVersion: "learning-flashcards@4",
    })
    .returning();
  deckId = deck.id;
  const notebookId = await seedNotebook(db, ownerAuth(owner.userId, owner.workspaceId));
  const [session] = await db
    .insert(explainSessions)
    .values({
      workspaceId: owner.workspaceId,
      notebookId,
      userId: owner.userId,
      sourceManifest: [],
      generationKey: `explain-${Date.now()}`,
      promptVersion: "learning-explain-it@2",
    })
    .returning();
  const [turn] = await db
    .insert(explainTurns)
    .values({
      workspaceId: owner.workspaceId,
      sessionId: session.id,
      ordinal: 0,
      prompt: "Explain it",
      answer: "My answer",
      grade: "partial",
      feedback: "Close, but the source says more.",
    })
    .returning();
  explainTurnId = turn.id;
});

afterAll(async () => {
  await handle.client.end();
});

describe("llm_feedback", () => {
  it("rates a chat reply by its turn and reads it back by sequence, with the run's model", async () => {
    const result = await ratings.rateOutput(owner, { output: { surface: "chat", runId, turnId }, score: 4 });
    expect(result).toEqual({ rating: { score: 4, comment: null } });
    expect(await ratings.chatRatingsForRun(owner, runId)).toEqual([{ score: 4, comment: null, sequence: 2, turnId }]);
    const [row] = await handle.db.select().from(llmFeedback).where(eq(llmFeedback.userId, owner.userId));
    expect(row).toMatchObject({ surface: "chat", model: "openai/gpt-test", promptVersion: null });
  });

  it("one rating per person per output: the stored address updates the same row", async () => {
    await ratings.rateOutput(owner, { output: { surface: "chat", runId, sequence: 2 }, score: 2 });
    const rows = await handle.db.select().from(llmFeedback).where(eq(llmFeedback.userId, owner.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: 2, version: 2 });
  });

  it("another member's rating of the same reply is their own", async () => {
    await ratings.rateOutput(member, { output: { surface: "chat", runId, turnId }, score: 5 });
    expect(await ratings.chatRatingsForRun(member, runId)).toEqual([{ score: 5, comment: null, sequence: 2, turnId }]);
    expect((await ratings.chatRatingsForRun(owner, runId))[0].score).toBe(2);
  });

  it("the person's own message is not a model output", async () => {
    expect(await ratings.rateOutput(owner, { output: { surface: "chat", runId, sequence: 1 }, score: 3 })).toBeNull();
  });

  it("an output in another workspace answers like a missing one", async () => {
    expect(await ratings.rateOutput(stranger, { output: { surface: "chat", runId, turnId }, score: 1 })).toBeNull();
    expect(await ratings.rateOutput(stranger, { output: { surface: "quiz", id: quizId }, score: 1 })).toBeNull();
  });

  it("a quiz rating copies the quiz's model and prompt version", async () => {
    await ratings.rateOutput(owner, { output: { surface: "quiz", id: quizId }, score: 1, comment: "Too easy" });
    expect(await ratings.ratingOf(owner, { surface: "quiz", id: quizId })).toEqual({ score: 1, comment: "Too easy" });
    const [row] = await handle.db.select().from(llmFeedback).where(eq(llmFeedback.quizId, quizId));
    expect(row).toMatchObject({ model: "openrouter:openai/gpt-4o-mini", promptVersion: "learn-quiz@7" });
  });

  it("re-picking a face keeps the note; an explicit null note removes it", async () => {
    await ratings.rateOutput(owner, { output: { surface: "flashcards", id: deckId }, score: 3, comment: "Wordy" });
    await ratings.rateOutput(owner, { output: { surface: "flashcards", id: deckId }, score: 4 });
    expect(await ratings.ratingOf(owner, { surface: "flashcards", id: deckId })).toEqual({
      score: 4,
      comment: "Wordy",
    });
    await ratings.rateOutput(owner, { output: { surface: "flashcards", id: deckId }, score: 4, comment: null });
    expect(await ratings.ratingOf(owner, { surface: "flashcards", id: deckId })).toEqual({ score: 4, comment: null });
  });

  it("an Explain It verdict can be rated only by the person who sat the session", async () => {
    expect(
      await ratings.rateOutput(member, { output: { surface: "explain", id: explainTurnId }, score: 5 }),
    ).toBeNull();
    await ratings.rateOutput(owner, { output: { surface: "explain", id: explainTurnId }, score: 5 });
    const map = await ratings.ratingsOf(owner, "explain", [explainTurnId]);
    expect(map.get(explainTurnId)).toEqual({ score: 5, comment: null });
    const [row] = await handle.db.select().from(llmFeedback).where(eq(llmFeedback.explainTurnId, explainTurnId));
    expect(row.promptVersion).toBe("learning-explain-it@2");
  });

  it("a null score clears the rating", async () => {
    await ratings.rateOutput(owner, { output: { surface: "flashcards", id: deckId }, score: null });
    expect(await ratings.ratingOf(owner, { surface: "flashcards", id: deckId })).toBeNull();
  });

  it("rejects a score outside 1-5 before touching the database", async () => {
    await expect(ratings.rateOutput(owner, { output: { surface: "quiz", id: quizId }, score: 6 })).rejects.toThrow(
      RangeError,
    );
  });

  it("a run's thumbs-down is a 0, refused everywhere else, and 👍 is graded", async () => {
    expect(
      await ratings.rateOutput(owner, { output: { surface: "run", id: runId }, score: 0, comment: "Wrong: stale" }),
    ).toEqual({
      rating: { score: 0, comment: "Wrong: stale" },
    });
    expect(await ratings.ratingOf(owner, { surface: "run", id: runId })).toEqual({ score: 0, comment: "Wrong: stale" });
    await expect(ratings.rateOutput(owner, { output: { surface: "quiz", id: quizId }, score: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      handle.client`insert into llm_feedback (workspace_id, user_id, surface, quiz_id, score)
        values (${owner.workspaceId}, ${owner.userId}, 'quiz', ${quizId}, 0)`,
    ).rejects.toThrow(/llm_feedback_score_check/);
    // A graded thumbs-up replaces the 0 (the page clears the thumbs-down first, so no stale comment rides along).
    await ratings.rateOutput(owner, { output: { surface: "run", id: runId }, score: null });
    await ratings.rateOutput(owner, { output: { surface: "run", id: runId }, score: 5 });
    expect(await ratings.ratingOf(owner, { surface: "run", id: runId })).toEqual({ score: 5, comment: null });
    const [row] = await handle.db.select().from(llmFeedback).where(eq(llmFeedback.runId, runId));
    expect(row).toMatchObject({ surface: "run", model: "openai/gpt-test" });
  });

  it("the readout keeps the thumbs-down share apart from the graded average", async () => {
    await ratings.rateOutput(member, { output: { surface: "run", id: runId }, score: 0 });
    const run = (await ratings.feedbackReadout(owner)).find((row) => row.surface === "run");
    expect(run).toMatchObject({ count: 2, thumbsDown: 1, average: 5, distribution: [0, 0, 0, 0, 1] });
    await ratings.rateOutput(member, { output: { surface: "run", id: runId }, score: null });
  });

  it("the readout groups by surface, model and prompt version, with a per-score distribution", async () => {
    const rows = await ratings.feedbackReadout(owner);
    const chat = rows.find((row) => row.surface === "chat");
    expect(chat).toMatchObject({ model: "openai/gpt-test", promptVersion: null, count: 2, average: 3.5 });
    expect(chat?.distribution).toEqual([0, 1, 0, 0, 1]);
    expect(rows.find((row) => row.surface === "quiz")).toMatchObject({
      promptVersion: "learn-quiz@7",
      count: 1,
      distribution: [1, 0, 0, 0, 0],
    });
    expect(rows.some((row) => row.surface === "flashcards")).toBe(false);
    expect(rows.find((row) => row.surface === "run")).toMatchObject({ count: 1, thumbsDown: 0, average: 5 });
    const notes = await ratings.recentFeedbackComments(owner);
    expect(notes.map((note) => note.comment)).toEqual(["Too easy"]);
  });

  it("the readout is an admin read", async () => {
    await expect(ratings.feedbackReadout(member)).rejects.toThrow();
    expect(await ratings.feedbackReadout(stranger)).toEqual([]);
  });
});
