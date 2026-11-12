import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobObjects } from "@/domains/audit/schema";
import { rewardDefinitions, rewardLedger } from "@/domains/gamification/schema";
import { documents, documentExtractions, files } from "@/domains/knowledge/schema";
import { quizAttempts, quizQuestions, quizzes } from "@/domains/learning/schema";
import { makeTestDb, seedWorkspace, ownerAuth } from "../helpers/test-workspace";

/*
 * The learning loop end to end on real Postgres: generate from a succeeded
 * extraction, verify evidence spans, complete an attempt, and earn exactly
 * one stone - including a replayed idempotency key and a second workspace
 * that must see none of it. No LLM here: the generator is a fixture.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let generate: typeof import("@/domains/learning/generate-quiz");
let commands: typeof import("@/domains/learning/commands");
let learningQueries: typeof import("@/domains/learning/queries");
let gamificationQueries: typeof import("@/domains/gamification/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  generate = await import("@/domains/learning/generate-quiz");
  commands = await import("@/domains/learning/commands");
  learningQueries = await import("@/domains/learning/queries");
  gamificationQueries = await import("@/domains/gamification/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

const TEXT =
  "The lease renews on March 1. Rent rises by 4% unless the tenant gives notice within 60 days. The deposit is held in escrow.";

async function seed() {
  const { userId, workspaceId } = await seedWorkspace(db, `learning-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  return ownerAuth(userId, workspaceId);
}

async function seedDocument(
  auth: ReturnType<typeof ownerAuth>,
  text: string | null,
  status: "succeeded" | "failed" | null = "succeeded",
  title = "Fixture lease",
) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "fixture.txt" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "text/plain" })
    .returning();
  const [extraction] = status
    ? await db
        .insert(documentExtractions)
        .values({ workspaceId: auth.workspaceId, documentId: doc.id, contentHash: blob.contentHash, status, text })
        .returning()
    : [];
  return { doc, extraction };
}

/** Three questions whose quotes are verbatim passages of TEXT. */
function leaseQuestions() {
  return [
    {
      prompt: "What happens to rent?",
      choices: [
        { value: "rises", label: "Rent rises by 4% unless notice is given within 60 days." },
        { value: "falls", label: "Rent falls by 4% unless notice is given within 60 days." },
      ],
      answerValue: "rises",
      concept: "Rent increase",
      explanation: "The lease states a 4% rise absent notice.",
      quote: "Rent rises by 4% unless the tenant gives notice within 60 days.",
    },
    {
      prompt: "When does the lease renew?",
      choices: [
        { value: "march", label: "March 1." },
        { value: "april", label: "April 1." },
      ],
      answerValue: "march",
      concept: "Renewal date",
      explanation: "The lease renews on March 1.",
      quote: "The lease renews on March 1.",
    },
    {
      prompt: "Where is the deposit held?",
      choices: [
        { value: "escrow", label: "In escrow." },
        { value: "landlord", label: "By the landlord directly." },
      ],
      answerValue: "escrow",
      concept: "Deposit",
      explanation: "The deposit is held in escrow.",
      quote: "The deposit is held in escrow.",
    },
  ];
}

const fixtureGenerator = (questions = leaseQuestions()) => ({
  name: "fixture:quiz",
  generate: async () => ({ questions }),
});

suite("learning loop", () => {
  it("generates a ready quiz whose evidence spans re-locate exactly in the extraction", async () => {
    const auth = await seed();
    const { doc, extraction } = await seedDocument(auth, TEXT);

    const out = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());
    expect(out.questionCount).toBe(3);
    expect(out.droppedQuestions).toBe(0);

    const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, out.quizId));
    expect(quiz.status).toBe("ready");
    expect(quiz.sourceExtractionId).toBe(extraction.id);
    expect(quiz.model).toBe("fixture:quiz");
    const questions = await db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, out.quizId))
      .orderBy(quizQuestions.ordinal);
    expect(questions).toHaveLength(3);
    for (const [i, q] of questions.entries()) {
      expect(q.ordinal).toBe(i);
      expect(q.evidence.startOffset).toBe(TEXT.indexOf(q.evidence.quote));
      expect(q.evidence.endOffset).toBe(q.evidence.startOffset + q.evidence.quote.length);
      expect(TEXT.slice(q.evidence.startOffset, q.evidence.endOffset)).toBe(q.evidence.quote);
    }
  });

  it("a 30-question request runs two batches, tells the second what exists, and drops a repeat", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const [template] = leaseQuestions();
    const calls: Array<{ questionCount?: number; avoidPrompts: string[] }> = [];
    const batching = {
      name: "fixture:quiz",
      generate: async (
        _text: string,
        options?: { questionCount?: number; avoidPrompts?: string[] },
      ): Promise<{ questions: ReturnType<typeof leaseQuestions> }> => {
        calls.push({ questionCount: options?.questionCount, avoidPrompts: options?.avoidPrompts ?? [] });
        const offset = (calls.length - 1) * 25;
        const questions = Array.from({ length: options?.questionCount ?? 0 }, (_, i) => ({
          ...template,
          prompt: `Rent question ${offset + i}?`,
        }));
        // The second batch repeats a first-batch prompt in different case.
        if (calls.length === 2) questions[0] = { ...template, prompt: "RENT question 0?" };
        return { questions };
      },
    };

    const idempotencyKey = crypto.randomUUID();
    const out = await generate.generateQuiz(auth, { documentId: doc.id, questionCount: 30, idempotencyKey }, batching);

    expect(calls.map((call) => call.questionCount)).toEqual([25, 5]);
    expect(calls[1].avoidPrompts).toHaveLength(25);
    expect(out).toMatchObject({ questionCount: 29, requested: 30, stoppedBy: "source_exhausted" });
    const stored = await db.select().from(quizQuestions).where(eq(quizQuestions.quizId, out.quizId));
    expect(stored).toHaveLength(29);
    const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, out.quizId));
    expect(quiz).toMatchObject({ questionCount: 29, requestedCount: 30, stoppedBy: "source_exhausted" });

    // A replay of the same request returns the stored quiz and count without a model call.
    const replay = await generate.generateQuiz(
      auth,
      { documentId: doc.id, questionCount: 30, idempotencyKey },
      batching,
    );
    expect(replay).toMatchObject({
      quizId: out.quizId,
      questionCount: 29,
      requested: 30,
      stoppedBy: "source_exhausted",
    });
    expect(calls).toHaveLength(2);
  });

  it("refuses a document with no succeeded extraction and persists nothing", async () => {
    const auth = await seed();
    await seedDocument(auth, null, "failed");

    await expect(
      generate.generateQuiz(
        auth,
        { documentId: (await db.select().from(documents).where(eq(documents.workspaceId, auth.workspaceId)))[0].id },
        fixtureGenerator(),
      ),
    ).rejects.toMatchObject({ code: "no_extraction" });
    expect(await db.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId))).toHaveLength(0);

    await expect(
      generate.generateQuiz(auth, { documentId: crypto.randomUUID() }, fixtureGenerator()),
    ).rejects.toMatchObject({ code: "document_not_found" });
    expect(await db.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId))).toHaveLength(0);
  });

  it("writes an honest failed row when too few questions verify", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const thin = leaseQuestions().slice(0, 2);

    await expect(generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator(thin))).rejects.toMatchObject({
      code: "insufficient_evidence",
    });

    const [failed] = await db.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId));
    expect(failed.status).toBe("failed");
    expect(failed.questionCount).toBe(0);
    expect(failed.error).toContain("2 of 2");
  });

  it("completes an attempt with server-side grading and exactly one stone; a replayed key earns nothing more", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const { quizId } = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());

    const questions = await learningQueries.getQuizForSitting(auth, quizId);
    expect(questions).not.toBeNull();
    expect(questions!.questions).toHaveLength(3);

    // Two correct, one wrong: the server's grading decides the score - the
    // client never sends one. Two of three clears the §6 score gate (a
    // sitting below two-thirds correct earns nothing).
    const answers = questions!.questions.map((q, i) =>
      i === 2
        ? { questionId: q.id, selectedValue: q.choices.find((c) => c.value !== q.answerValue)!.value, dontKnow: false }
        : { questionId: q.id, selectedValue: q.answerValue, dontKnow: false },
    );
    const idempotencyKey = `attempt-${crypto.randomUUID()}`;
    const first = await commands.completeQuizAttempt(auth, { quizId, answers, idempotencyKey });
    expect(first).toMatchObject({ correctCount: 2, totalCount: 3, stoneEarned: true, replayed: false });

    const attempts = await db.select().from(quizAttempts).where(eq(quizAttempts.workspaceId, auth.workspaceId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].correctCount).toBe(2);
    expect(attempts[0].totalCount).toBe(3);

    const ledger = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      reason: "learning_reviewed",
      points: 10,
      subjectType: "quiz_attempt",
      subjectId: first.attemptId,
      idempotencyKey: `quiz_attempt:${first.attemptId}`,
    });
    const [definition] = await db
      .select()
      .from(rewardDefinitions)
      .where(eq(rewardDefinitions.workspaceId, auth.workspaceId));
    expect(definition.key).toBe("learning_reviewed");

    // The score is a derivation: the overview reads the ledger, not a balance.
    const overview = await gamificationQueries.getRewardsOverview(auth);
    expect(overview.totalPoints).toBe(10);

    // A lost response replayed: the attempt already happened, no second stone.
    const replay = await commands.completeQuizAttempt(auth, { quizId, answers, idempotencyKey });
    expect(replay).toMatchObject({ attemptId: first.attemptId, correctCount: 2, stoneEarned: false, replayed: true });
    expect(await db.select().from(quizAttempts).where(eq(quizAttempts.workspaceId, auth.workspaceId))).toHaveLength(1);
    expect(await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId))).toHaveLength(1);
  });

  it("cuts read-first passages from the quiz's own extraction, never another workspace's", async () => {
    const auth = await seed();
    const other = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const { extraction: foreign } = await seedDocument(other, TEXT);
    const { quizId } = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());

    const sitting = await learningQueries.getQuizForSitting(auth, quizId);
    // The source is shorter than a passage, so it is the whole passage.
    expect(sitting!.passages).toEqual([
      {
        id: expect.any(String),
        sourceTitle: "Fixture lease",
        body: TEXT,
        questionIds: sitting!.questions.map((q) => q.id),
      },
    ]);

    // A question whose evidence names another workspace's extraction reads
    // nothing from it: no passage, and none of that text.
    const [moved] = sitting!.questions;
    await db
      .update(quizQuestions)
      .set({
        evidence: {
          ...moved.evidence,
          source: { documentId: foreign.documentId, extractionId: foreign.id, title: "Theirs" },
        },
      })
      .where(eq(quizQuestions.id, moved.id));
    const after = await learningQueries.getQuizForSitting(auth, quizId);
    expect(after!.passages.flatMap((p) => p.questionIds)).toEqual(sitting!.questions.slice(1).map((q) => q.id));
    expect(after!.passages.map((p) => p.sourceTitle)).toEqual(["Fixture lease"]);
  });

  it("names sources by their own headings and leaves a link index out of the quiz", async () => {
    const auth = await seed();
    // Three pasted docs pages: the first line of each, a quoted site notice, became its stored title.
    const RAW_TITLE = "> ## Documentation Index";
    const NOTICE = `${RAW_TITLE}\n> Fetch the complete documentation index at: https://docs.example.test/llms.txt\n\n`;
    const LEASE = `${NOTICE}# Lease terms\n\n${TEXT}`;
    const LINKS =
      "* **[Alpha](https://example.test/alpha)** - Issue tracker access\n* **[Beta](https://example.test/beta)** - Calendar and scheduling";
    const RULES =
      "The deposit is returned within 30 days of the tenant moving out. The landlord may keep part of it only for damage beyond ordinary wear, and must list each deduction in writing. A tenant who disagrees with a deduction has 14 days to dispute it before the amount is treated as accepted.";
    const MIXED = `${NOTICE}# Deposit rules\n\n${RULES}\n\n${LINKS}`;
    const INDEX = `${NOTICE}# Community servers\n\n${LINKS}\n* **[Gamma](https://example.test/gamma)** - Object storage browsing`;
    const docs = [];
    for (const text of [LEASE, MIXED, INDEX]) docs.push((await seedDocument(auth, text, "succeeded", RAW_TITLE)).doc);

    const shown: Array<{ title: string; text: string }> = [];
    const generator = {
      name: "fixture:quiz",
      generate: async () => ({ questions: [] }),
      generateFromSources: async (sources: Array<{ title: string; text: string }>) => {
        shown.push(...sources);
        return {
          questions: [
            ...leaseQuestions().map((question) => ({ ...question, sourceIndex: 0 })),
            // Quotes an index entry: the model was never shown it, and it must not survive if it guesses.
            { ...leaseQuestions()[0], prompt: "What does Beta do?", quote: "Calendar and scheduling", sourceIndex: 1 },
          ],
        };
      },
    };
    const out = await generate.generateQuiz(
      auth,
      { documentId: docs[0].id, documentIds: docs.map((doc) => doc.id), questionCount: 5 },
      generator,
    );

    expect(shown.map((source) => source.title)).toEqual(["Lease terms", "Deposit rules"]);
    expect(shown.map((source) => source.text).join("\n")).not.toMatch(/llms\.txt|\]\(https:/);
    expect(shown[1].text).toContain("The deposit is returned within 30 days");
    expect(out).toMatchObject({ questionCount: 3, droppedQuestions: 1 });

    const [row] = await db.select().from(quizzes).where(eq(quizzes.id, out.quizId));
    expect(row.title).toBe("Lease terms + 1 more");
    expect(row.sourceManifest.map(({ title, skipped }) => ({ title, skipped }))).toEqual([
      { title: "Lease terms", skipped: undefined },
      { title: "Deposit rules", skipped: undefined },
      { title: "Community servers", skipped: true },
    ]);

    const sitting = await learningQueries.getQuizForSitting(auth, out.quizId);
    expect(sitting!.title).toBe("Lease terms + 1 more");
    expect(sitting!.sources.map(({ label, skipped }) => ({ label, skipped }))).toEqual([
      { label: "Lease terms", skipped: false },
      { label: "Deposit rules", skipped: false },
      { label: "Community servers", skipped: true },
    ]);
    expect(sitting!.passages.map((passage) => passage.sourceTitle)).toEqual(["Lease terms"]);
    expect(sitting!.passages[0].body).not.toContain("llms.txt");

    // A selection of nothing but an index fails with a reason the library can show.
    const indexOnly = (await seedDocument(auth, INDEX, "succeeded", RAW_TITLE)).doc;
    await expect(generate.generateQuiz(auth, { documentId: indexOnly.id }, generator)).rejects.toMatchObject({
      code: "insufficient_evidence",
      message: "This source is a list of links, with nothing explained to ask about.",
    });
    const [failed] = await db.select().from(quizzes).where(eq(quizzes.documentId, indexOnly.id));
    expect(failed).toMatchObject({ status: "failed", title: "Community servers" });
  });

  it("rejects answers that are not a full sitting over the quiz's own questions", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const { quizId } = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());
    const sitting = await learningQueries.getQuizForSitting(auth, quizId);

    await expect(
      commands.completeQuizAttempt(auth, {
        quizId,
        answers: [
          { questionId: sitting!.questions[0].id, selectedValue: sitting!.questions[0].answerValue, dontKnow: false },
        ],
        idempotencyKey: `k-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_answers" });

    const [q0] = sitting!.questions;
    await expect(
      commands.completeQuizAttempt(auth, {
        quizId,
        answers: [
          { questionId: q0.id, selectedValue: "not-a-choice", dontKnow: false },
          ...sitting!.questions.slice(1).map((q) => ({ questionId: q.id, selectedValue: null, dontKnow: true })),
        ],
        idempotencyKey: `k-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_answers" });

    await expect(
      commands.completeQuizAttempt(auth, {
        quizId,
        answers: [
          { questionId: q0.id, selectedValue: q0.answerValue, dontKnow: true },
          ...sitting!.questions.slice(1).map((q) => ({ questionId: q.id, selectedValue: null, dontKnow: true })),
        ],
        idempotencyKey: `k-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_answers" });
  });

  it("keeps workspaces blind to each other's quizzes and attempts", async () => {
    const authA = await seed();
    const authB = await seed();
    const { doc } = await seedDocument(authA, TEXT);
    const { quizId } = await generate.generateQuiz(authA, { documentId: doc.id }, fixtureGenerator());

    expect(await learningQueries.getLearnLibrary(authB)).toHaveLength(0);
    expect(await learningQueries.getQuizForSitting(authB, quizId)).toBeNull();
    await expect(
      commands.completeQuizAttempt(authB, {
        quizId,
        answers: [{ questionId: crypto.randomUUID(), selectedValue: null, dontKnow: true }],
        idempotencyKey: `k-${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "quiz_not_found" });

    const library = await learningQueries.getLearnLibrary(authA);
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({
      documentId: doc.id,
      quizId,
      questionCount: 3,
      bestCorrect: null,
      lastAttemptedAt: null,
    });

    // Completing in A stays in A: B's ledger is untouched.
    const sitting = await learningQueries.getQuizForSitting(authA, quizId);
    await commands.completeQuizAttempt(authA, {
      quizId,
      answers: sitting!.questions.map((q) => ({ questionId: q.id, selectedValue: q.answerValue, dontKnow: false })),
      idempotencyKey: `k-${crypto.randomUUID()}`,
    });
    // Completing in A stays in A: B's ledger is untouched, and A's holds the
    // sitting award plus the first-time perfect-sitting emerald stone.
    expect(await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, authB.workspaceId))).toHaveLength(0);
    const aLedger = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, authA.workspaceId));
    expect(aLedger.filter((r) => r.points > 0)).toHaveLength(1); // the sitting award
    expect(aLedger.filter((r) => r.points === 0)).toHaveLength(1); // first-time emerald
  });

  it("regeneration creates a new quiz rather than overwriting the first", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);
    const first = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());
    const second = await generate.generateQuiz(
      auth,
      { documentId: doc.id },
      fixtureGenerator(
        leaseQuestions()
          .slice(0, 3)
          .map((q) => ({ ...q, prompt: `${q.prompt} (v2)` })),
      ),
    );
    expect(second.quizId).not.toBe(first.quizId);
    expect(await db.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId))).toHaveLength(2);
  });

  it("a failed generation stores authored copy the library shows, with the ready quiz still retakeable", async () => {
    const auth = await seed();
    const { doc } = await seedDocument(auth, TEXT);

    await expect(
      generate.generateQuiz(
        auth,
        { documentId: doc.id },
        {
          name: "fixture:fail",
          generate: async () => {
            throw new Error("the driver exploded");
          },
        },
      ),
    ).rejects.toBeInstanceOf(generate.QuizGenerationError);
    // The row stores the authored sentence, never the driver's text, and the
    // library read surfaces it: a failure is news, not a silent nothing.
    const [failed] = await db.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId));
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(generate.GENERATION_COPY.generation_failed);
    let rows = await learningQueries.getLearnLibrary(auth);
    expect(rows[0].quizId).toBeNull();
    expect(rows[0].lastFailure).toBe(generate.GENERATION_COPY.generation_failed);

    // A later successful generation wins, and the failure is gone.
    const ready = await generate.generateQuiz(auth, { documentId: doc.id }, fixtureGenerator());
    rows = await learningQueries.getLearnLibrary(auth);
    expect(rows[0].quizId).toBe(ready.quizId);
    expect(rows[0].lastFailure).toBeNull();

    // A failed REgeneration after a ready quiz: both facts show - the ready
    // quiz stays retakeable and the failure is named.
    await expect(
      generate.generateQuiz(
        auth,
        { documentId: doc.id },
        {
          name: "fixture:fail",
          generate: async () => {
            throw new Error("the driver exploded again");
          },
        },
      ),
    ).rejects.toBeInstanceOf(generate.QuizGenerationError);
    rows = await learningQueries.getLearnLibrary(auth);
    expect(rows[0].quizId).toBe(ready.quizId);
    expect(rows[0].lastFailure).toBe(generate.GENERATION_COPY.generation_failed);
  });
});
