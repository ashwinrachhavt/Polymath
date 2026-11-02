import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { waitSettled } from "./helpers/settled";

/*
 * The learning loop (ASH-303): the /learn library, its honest states, and a
 * full quiz sitting with instant feedback ending in exactly one stone. The
 * quiz is seeded - no model is in this journey anywhere - so the e2e proves
 * the surface and the reward wiring, not generation quality.
 */

const DOC_TITLE = "Polymath learning notes";
const STILL_READING_TITLE = "Polymath learning notes (still reading)";

const DOC_TEXT =
  "The review queue settles each proposal with the gate's verdict, and every settle " +
  "writes a receipt and an audit row in the same transaction. Agent surfaces call " +
  "searchDocumentsForAgent for library passages and cite each used passage by title.";

/** Value-keyed choices straight from the domain rule: a typo'd answerValue is a hard error, not a silent wrong grade. */
const QUESTIONS = [
  {
    prompt: "When does a settle write its receipt and audit row?",
    choices: [
      { value: "same-transaction", label: "In the same transaction" },
      { value: "nightly-batch", label: "In a nightly batch job" },
      { value: "derived-later", label: "Never - they are derived later" },
    ],
    answerValue: "same-transaction",
    explanation:
      "Every settle writes a receipt and an audit row in the same transaction, so a crash cannot leave one behind.",
    quote: "every settle writes a receipt and an audit row in the same transaction",
  },
  {
    prompt: "What do agent surfaces cite when they use library passages?",
    choices: [
      { value: "byte-offsets", label: "The passages' byte offsets" },
      { value: "extraction-hash", label: "The extraction's content hash" },
      { value: "by-title", label: "Each used passage by title" },
    ],
    answerValue: "by-title",
    explanation: "Agent surfaces call searchDocumentsForAgent and cite each used passage by title.",
    quote: "cite each used passage by title",
  },
  {
    prompt: "How does the review queue settle a proposal?",
    choices: [
      { value: "authors-preference", label: "By the author's preference" },
      { value: "gates-verdict", label: "With the gate's verdict" },
      { value: "random-draw", label: "By a random draw" },
    ],
    answerValue: "gates-verdict",
    explanation: "The review queue settles each proposal with the gate's verdict.",
    quote: "The review queue settles each proposal with the gate's verdict",
  },
];

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

/**
 * One quizzable document (succeeded extraction + ready quiz with verified
 * questions and one prior attempt for the best-score state) and one document
 * still being read. Returns the ids the assertions need, or null without a
 * database.
 */
async function seedLearnFixture(): Promise<{ quizId: string; workspaceId: string } | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string; user_id: string }[]>`
      select m.workspace_id, m.user_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    await removeSeeded(client);
    const [doc] = await client<{ id: string }[]>`
      insert into documents (workspace_id, title, mime_type)
      values (${owner.workspace_id}, ${DOC_TITLE}, 'text/plain')
      returning id`;
    await client`
      insert into document_extractions (workspace_id, document_id, content_hash, status, text, spans, extractor)
      values (${owner.workspace_id}, ${doc.id}, 'e2e-learn-loop', 'succeeded', ${DOC_TEXT}, '[]'::jsonb, 'e2e@1')`;
    await client`
      update documents set active_extraction_id = (select id from document_extractions where document_id = ${doc.id})
      where id = ${doc.id}`;
    const [quiz] = await client<{ id: string }[]>`
      insert into quizzes (workspace_id, document_id, source_extraction_id, title, status, question_count, model, prompt_version)
      values (
        ${owner.workspace_id}, ${doc.id},
        (select id from document_extractions where document_id = ${doc.id}),
        'Review queue fundamentals', 'ready', ${QUESTIONS.length}, 'e2e-seed', 'e2e@1'
      )
      returning id`;
    let ordinal = 0;
    const questionIds: string[] = [];
    for (const question of QUESTIONS) {
      ordinal += 1;
      const [row] = await client<{ id: string }[]>`
        insert into quiz_questions (workspace_id, quiz_id, ordinal, prompt, choices, answer_value, explanation, evidence)
        values (
          ${owner.workspace_id}, ${quiz.id}, ${ordinal}, ${question.prompt},
          ${JSON.stringify(question.choices)}::jsonb, ${question.answerValue}, ${question.explanation},
          ${JSON.stringify({ quote: question.quote, startOffset: DOC_TEXT.indexOf(question.quote), endOffset: DOC_TEXT.indexOf(question.quote) + question.quote.length })}::jsonb
        )
        returning id`;
      questionIds.push(row.id);
    }
    // One prior attempt gives the library its "Best score" state.
    await client`
      insert into quiz_attempts (workspace_id, quiz_id, user_id, answers, correct_count, total_count, idempotency_key)
      values (
        ${owner.workspace_id}, ${quiz.id}, ${owner.user_id},
        ${JSON.stringify([
          { questionId: questionIds[0], selectedValue: "same-transaction", dontKnow: false },
          { questionId: questionIds[1], selectedValue: "byte-offsets", dontKnow: false },
          { questionId: questionIds[2], selectedValue: null, dontKnow: true },
        ])}::jsonb, 1, ${QUESTIONS.length}, ${`learn-e2e-seed:${quiz.id}`}
      )`;
    await client`
      insert into documents (workspace_id, title, mime_type)
      values (${owner.workspace_id}, ${STILL_READING_TITLE}, 'text/plain')`;
    return { quizId: quiz.id, workspaceId: owner.workspace_id };
  } finally {
    await client.end();
  }
}

async function removeSeeded(client: postgres.Sql): Promise<void> {
  // The ledger is append-only and not FK-cascaded: clear the rows this
  // journey's attempts earned before the cascading deletes take the ids.
  await client`
    delete from reward_ledger
    where subject_type = 'quiz_attempt'
      and subject_id in (
        select a.id from quiz_attempts a
        join quizzes q on q.id = a.quiz_id
        where q.document_id in (select id from documents where title in (${DOC_TITLE}, ${STILL_READING_TITLE}))
      )`;
  await client`delete from documents where title in (${DOC_TITLE}, ${STILL_READING_TITLE})`;
}

test.afterAll(async () => {
  const client = db();
  if (!client) return;
  try {
    await removeSeeded(client);
  } finally {
    await client.end();
  }
});

/** The balance the gamification domain derives from the ledger. */
async function ledgerTotal(client: postgres.Sql, workspaceId: string): Promise<number> {
  const [row] = await client<{ total: number }[]>`
    select coalesce(sum(points), 0)::int as total from reward_ledger where workspace_id = ${workspaceId}`;
  return row.total;
}

async function openLearn(page: Page): Promise<void> {
  await page.goto("/learn");
  await waitSettled(page);
}

test("the learning loop: library states, a sitting with instant feedback, and one stone", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await seedLearnFixture();
  test.skip(!fixture, "DATABASE_URL not configured (server and test).");
  await openLearn(page);

  // Dev streams the content subtree twice, so every assertion scopes to the
  // first #content (the pattern the other specs use).
  const content = page.locator("#content").first();

  // The library: learning state per document, the Stones stat, and the
  // honest state for the document still being read.
  await expect(content.getByRole("heading", { name: "Learn", level: 1 })).toBeVisible();
  await expect(content.getByText("Stones earned")).toBeVisible();
  const docRow = content.getByRole("listitem").filter({ has: page.getByText(DOC_TITLE, { exact: true }) });
  await expect(docRow).toContainText("Best score 1/3");
  await expect(docRow.getByRole("link", { name: "Retake" })).toBeVisible();
  const readingRow = content
    .getByRole("listitem")
    .filter({ has: page.getByText(STILL_READING_TITLE, { exact: true }) });
  await expect(readingRow).toContainText("Still reading this document");
  await expect(readingRow.getByRole("button", { name: "Generate quiz" })).toBeDisabled();

  const client = db();
  if (!client) throw new Error("DATABASE_URL disappeared mid-journey");
  const stonesBefore = await ledgerTotal(client, fixture!.workspaceId);

  // Open the quiz: one question at a time, choices plus the apart
  // I-don't-know option.
  await docRow.getByRole("link", { name: "Retake" }).click();
  await expect(content.getByText("Question 1 of 3")).toBeVisible();
  await expect(content.getByRole("button", { name: "I don't know" })).toBeVisible();

  // Correct answer: instant mark, then the explanation.
  await content.getByRole("button", { name: "In the same transaction" }).click();
  await expect(content.getByText("Correct!")).toBeVisible();
  await expect(content.getByText("so a crash cannot leave one behind")).toBeVisible();
  await content.getByRole("button", { name: "Next question" }).click();

  // Wrong answer: the mark, the correct answer named, no award yet.
  await expect(content.getByText("Question 2 of 3")).toBeVisible();
  await content.getByRole("button", { name: "The passages' byte offsets" }).click();
  await expect(content.getByText("Incorrect. The correct answer is:")).toBeVisible();
  await content.getByRole("button", { name: "Next question" }).click();

  // The gap: I-don't-know reveals the answer without a wrong mark.
  await expect(content.getByText("Question 3 of 3")).toBeVisible();
  await content.getByRole("button", { name: "I don't know" }).click();
  await expect(content.getByText("Kept as an honest gap.")).toBeVisible();
  await content.getByRole("button", { name: "Finish" }).click();

  // The sitting is recorded; one ledger row earned the stone exactly once.
  await expect(content.getByText("1 of 3")).toBeVisible();
  await expect(content.getByText("+10 stones for finishing this quiz.")).toBeVisible();
  const rows = await client<{ idempotency_key: string; points: number }[]>`
    select idempotency_key, points
    from reward_ledger
    where subject_type = 'quiz_attempt'
      and subject_id in (select id from quiz_attempts where quiz_id = ${fixture!.quizId})
    order by created_at desc limit 1`;
  expect(rows).toHaveLength(1);
  expect(rows[0].points).toBe(10);
  expect(rows[0].idempotency_key).toMatch(/^quiz_attempt:/);
  await client.end();

  // The balance the surface derives from that ledger: the rewards page
  // shows it through the gamification domain's queries.
  const earned = Number(stonesBefore) + 10;
  await page.goto("/apps/neuralflow/rewards");
  await waitSettled(page);
  await expect(page.locator("#content").first().getByText("Points earned")).toBeVisible();
  await expect(page.getByText(String(earned)).first()).toBeVisible();
  await openLearn(page);
  await expect(page.locator("#content").first().getByText("Best score 1/3")).toBeVisible();
});
