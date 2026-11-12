import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concepts } from "@/domains/knowledge/schema";
import { conceptLinks, explainTurns, flashcards, quizQuestions } from "@/domains/learning/schema";
import type { ExplainItGenerator } from "@/integrations/learning/explain-it";
import type { GeneratedQuestion } from "@/integrations/learning/quiz-generator";
import { seedNotebook, seedReadDocument } from "../helpers/learning-fixtures";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The concept link on real Postgres: whatever generation stores names the
 * concept it is about, one idea keeps one id inside a workspace, and no
 * workspace can read or point at another's concepts. No model here.
 */

const handle = makeTestDb();
let db: typeof handle.db;
let quiz: typeof import("@/domains/learning/generate-quiz");
let decks: typeof import("@/domains/learning/flashcards");
let explain: typeof import("@/domains/learning/explain-it");
let knowledgeConcepts: typeof import("@/domains/knowledge/concepts");
let transaction: typeof import("@/lib/db-transaction");

beforeAll(async () => {
  ({ db } = handle);
  quiz = await import("@/domains/learning/generate-quiz");
  decks = await import("@/domains/learning/flashcards");
  explain = await import("@/domains/learning/explain-it");
  knowledgeConcepts = await import("@/domains/knowledge/concepts");
  transaction = await import("@/lib/db-transaction");
});

afterAll(async () => {
  await handle.client.end();
});

const TEXT =
  "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days. The deposit is held in escrow. Repairs under $200 are the tenant's to pay. The landlord must give 24 hours notice before entering.";

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return ownerAuth(userId, workspaceId);
}

function question(prompt: string, quote: string, concept: string | undefined): GeneratedQuestion {
  return {
    prompt,
    choices: [
      { value: "a", label: "The first claim" },
      { value: "b", label: "The second claim" },
    ],
    answerValue: "a",
    explanation: "The source says so.",
    quote,
    concept,
  };
}

const leaseQuestions = (): GeneratedQuestion[] => [
  question("When does the lease renew?", "The lease renews on March 1.", "Renewal date"),
  question("What happens to rent?", "Rent rises by 4% unless the tenant gives notice within 60 days.", "Rent increase"),
  question("Where is the deposit?", "The deposit is held in escrow.", "Deposit"),
  question("How much notice stops the rise?", "unless the tenant gives notice within 60 days", "  rent   INCREASE "),
  question("Who pays small repairs?", "Repairs under $200 are the tenant's to pay.", undefined),
];

async function conceptsByItem(workspaceId: string) {
  return db
    .select({
      conceptId: conceptLinks.conceptId,
      term: concepts.term,
      quizQuestionId: conceptLinks.quizQuestionId,
      flashcardId: conceptLinks.flashcardId,
      explainTurnId: conceptLinks.explainTurnId,
    })
    .from(conceptLinks)
    .innerJoin(concepts, eq(concepts.id, conceptLinks.conceptId))
    .where(eq(conceptLinks.workspaceId, workspaceId));
}

describe("concept links", () => {
  it("every stored quiz question names a concept, and a proposal that names none is dropped", async () => {
    const auth = await seed("concept-quiz");
    const { documentId } = await seedReadDocument(db, auth, TEXT);

    const made = await quiz.generateQuiz(
      auth,
      { documentId },
      { name: "fixture:quiz", generate: async () => ({ questions: leaseQuestions() }) },
    );

    expect(made).toMatchObject({ questionCount: 4, droppedQuestions: 1 });
    const questions = await db.select().from(quizQuestions).where(eq(quizQuestions.quizId, made.quizId));
    const links = await conceptsByItem(auth.workspaceId);
    for (const stored of questions) {
      expect(links.filter((link) => link.quizQuestionId === stored.id)).toHaveLength(1);
    }
    expect(questions.map((stored) => stored.prompt)).not.toContain("Who pays small repairs?");
  });

  it("one idea keeps one id: letter case and spacing do not make a second concept", async () => {
    const auth = await seed("concept-identity");
    const { documentId } = await seedReadDocument(db, auth, TEXT);
    await quiz.generateQuiz(
      auth,
      { documentId },
      { name: "fixture:quiz", generate: async () => ({ questions: leaseQuestions() }) },
    );

    const links = await conceptsByItem(auth.workspaceId);
    const rent = links.filter((link) => link.term.toLowerCase() === "rent increase");
    expect(rent).toHaveLength(2);
    expect(new Set(rent.map((link) => link.conceptId)).size).toBe(1);
    expect(new Set(links.map((link) => link.conceptId)).size).toBe(3);
  });

  it("a question about an existing Idea links to that Idea's concept instead of making another", async () => {
    const auth = await seed("concept-idea");
    const [idea] = await db
      .insert(concepts)
      .values({ workspaceId: auth.workspaceId, term: "Deposit", sense: "domain", definition: "Money held against damage." })
      .returning();
    const { documentId } = await seedReadDocument(db, auth, TEXT);
    await quiz.generateQuiz(
      auth,
      { documentId },
      { name: "fixture:quiz", generate: async () => ({ questions: leaseQuestions() }) },
    );

    const links = await conceptsByItem(auth.workspaceId);
    expect(links.filter((link) => link.term === "Deposit").map((link) => link.conceptId)).toEqual([idea.id]);
  });

  it("every stored flashcard names a concept, across batches", async () => {
    const auth = await seed("concept-cards");
    const { documentId } = await seedReadDocument(db, auth, TEXT);
    const sentences = TEXT.split(/(?<=\.)\s+/);
    const made = await decks.generateFlashcardDeck(
      auth,
      { documentIds: [documentId], cardCount: 5, idempotencyKey: crypto.randomUUID() },
      {
        name: "fixture:cards",
        generateFromSources: async () => ({
          cards: [
            ...sentences.map((sentence, i) => ({
              prompt: `What does sentence ${i} say?`,
              answer: sentence,
              quote: sentence,
              sourceIndex: 0,
              concept: `Clause ${i}`,
            })),
            { prompt: "An untagged card", answer: sentences[0], quote: sentences[0], sourceIndex: 0 },
          ],
        }),
      },
    );

    const cards = await db.select().from(flashcards).where(eq(flashcards.deckId, made.deckId));
    expect(cards).toHaveLength(5);
    const links = await conceptsByItem(auth.workspaceId);
    for (const card of cards) expect(links.filter((link) => link.flashcardId === card.id)).toHaveLength(1);
  });

  it("an Explain It question names its concept, and a follow-up that names none stays on it", async () => {
    const auth = await seed("concept-explain");
    const { documentId } = await seedReadDocument(db, auth, TEXT);
    const notebookId = await seedNotebook(db, auth);
    const followUps = [null, "Deposit"];
    const generator: ExplainItGenerator = {
      name: "fixture:explain",
      start: async () => ({
        prompt: "Why might rent not rise?",
        evidence: [{ quote: "Rent rises by 4% unless the tenant gives notice within 60 days.", sourceIndex: 0 }],
        concept: "Rent increase",
      }),
      evaluate: async () => ({
        grade: "correct",
        feedback: "Right.",
        evidence: [{ quote: "Rent rises by 4% unless the tenant gives notice within 60 days.", sourceIndex: 0 }],
        nextQuestion: "And what about the deposit?",
        nextEvidence: [{ quote: "The deposit is held in escrow.", sourceIndex: 0 }],
        nextConcept: followUps.shift() ?? null,
      }),
    };

    const { sessionId } = await explain.startExplainItSession(
      auth,
      { notebookId, documentIds: [documentId], idempotencyKey: crypto.randomUUID() },
      generator,
    );
    for (let i = 0; i < 2; i += 1) {
      const turns = await db.select().from(explainTurns).where(eq(explainTurns.sessionId, sessionId));
      const current = turns.find((turn) => turn.answer === null)!;
      await explain.answerExplainItTurn(
        auth,
        { notebookId, sessionId, turnId: current.id, answer: "Because notice was given." },
        generator,
      );
    }

    const turns = await db
      .select()
      .from(explainTurns)
      .where(eq(explainTurns.sessionId, sessionId))
      .orderBy(explainTurns.ordinal);
    const links = await conceptsByItem(auth.workspaceId);
    const termOf = (turnId: string) => links.filter((link) => link.explainTurnId === turnId).map((link) => link.term);
    expect(turns.map((turn) => termOf(turn.id))).toEqual([["Rent increase"], ["Rent increase"], ["Deposit"]]);
  });

  it("keeps workspaces blind to each other's concepts", async () => {
    const mine = await seed("concept-mine");
    const theirs = await seed("concept-theirs");
    const resolve = (auth: typeof mine, names: string[]) =>
      transaction.withTransaction((tx) => knowledgeConcepts.resolveConceptIds(auth, names, tx));

    const myIds = await resolve(mine, ["Rent increase", "Deposit"]);
    const theirIds = await resolve(theirs, ["Rent increase"]);

    expect(theirIds.get("rent increase")).not.toBe(myIds.get("rent increase"));
    expect(await knowledgeConcepts.recentConceptNames(theirs)).toEqual(["Rent increase"]);
    const visible = await db
      .select({ id: concepts.id })
      .from(concepts)
      .where(and(eq(concepts.workspaceId, theirs.workspaceId), inArray(concepts.id, [...myIds.values()])));
    expect(visible).toHaveLength(0);
  });

  it("the database refuses a link from one workspace to another's concept", async () => {
    const mine = await seed("concept-fk-mine");
    const theirs = await seed("concept-fk-theirs");
    const { documentId } = await seedReadDocument(db, theirs, TEXT);
    const made = await quiz.generateQuiz(
      theirs,
      { documentId },
      { name: "fixture:quiz", generate: async () => ({ questions: leaseQuestions() }) },
    );
    const [theirQuestion] = await db.select().from(quizQuestions).where(eq(quizQuestions.quizId, made.quizId));
    const [myConcept] = await db
      .insert(concepts)
      .values({ workspaceId: mine.workspaceId, term: "Private idea", sense: "domain" })
      .returning();

    await expect(
      db
        .insert(conceptLinks)
        .values({ workspaceId: theirs.workspaceId, conceptId: myConcept.id, quizQuestionId: theirQuestion.id }),
    ).rejects.toThrow();
  });
});
