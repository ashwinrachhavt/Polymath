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

  // The Learn queue (PR #557): quizzes with their best score and a
  // Continue link. A document still being read has no quiz, so it is not
  // queued; its honest state lives on its own quiz page.
  await expect(content.getByRole("heading", { name: "Learn", level: 1 })).toBeVisible();
  const quizzes = content.getByRole("region", { name: "Quizzes" });
  const docRow = quizzes.getByRole("listitem").filter({ has: page.getByText(DOC_TITLE, { exact: true }) });
  await expect(docRow).toContainText("Best score 1/3");
  await expect(docRow.getByRole("link", { name: "Continue" })).toBeVisible();
  await expect(quizzes.getByText(STILL_READING_TITLE, { exact: true })).toHaveCount(0);

  const client = db();
  if (!client) throw new Error("DATABASE_URL disappeared mid-journey");
  const stonesBefore = await ledgerTotal(client, fixture!.workspaceId);

  // Open the quiz: read first. The seeded text is short, so all three
  // questions share one passage, the source's own words, shown before them.
  await docRow.getByRole("link", { name: "Continue" }).click();
  await expect(content.getByText("Passage 1 of 1")).toBeVisible();
  await expect(content.getByRole("heading", { name: "Read this first" })).toBeVisible();
  await expect(content.getByText(DOC_TEXT)).toBeVisible();
  await content.getByRole("button", { name: "Continue" }).click();

  // Then one question at a time, choices plus the apart I-don't-know option.
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

  // The sitting is recorded, but 1 of 3 is under the learning gate (two
  // thirds correct, gamification rules spec §6), so it pays nothing.
  await expect(content.getByText("1 of 3")).toBeVisible();
  await expect(content.getByText("No stone for this sitting.")).toBeVisible();
  const ledgerRows = () => client<{ idempotency_key: string; points: number }[]>`
    select idempotency_key, points
    from reward_ledger
    where subject_type = 'quiz_attempt'
      and subject_id in (select id from quiz_attempts where quiz_id = ${fixture!.quizId})
    order by created_at desc`;
  expect(await ledgerRows()).toHaveLength(0);

  // A retake that clears the gate (2 of 3, the gap still honest) earns the
  // stone; one ledger row, exactly once.
  await content.getByRole("button", { name: "Retake" }).click();
  await content.getByRole("button", { name: "Continue" }).click();
  await expect(content.getByText("Question 1 of 3")).toBeVisible();
  await content.getByRole("button", { name: "In the same transaction" }).click();
  await content.getByRole("button", { name: "Next question" }).click();
  await expect(content.getByText("Question 2 of 3")).toBeVisible();
  await content.getByRole("button", { name: "Each used passage by title" }).click();
  await expect(content.getByText("Correct!")).toBeVisible();
  await content.getByRole("button", { name: "Next question" }).click();
  await expect(content.getByText("Question 3 of 3")).toBeVisible();
  await content.getByRole("button", { name: "I don't know" }).click();
  await content.getByRole("button", { name: "Finish" }).click();
  await expect(content.getByText("2 of 3")).toBeVisible();
  await expect(content.getByText("+10 stones for finishing this quiz.")).toBeVisible();
  const rows = await ledgerRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].points).toBe(10);
  expect(rows[0].idempotency_key).toMatch(/^quiz_attempt:/);
  await client.end();

  // The balance the surface derives from that ledger: the rewards page
  // shows it through the gamification domain's queries.
  const earned = Number(stonesBefore) + 10;
  await page.goto("/neuralflow/rewards");
  await waitSettled(page);
  await expect(page.locator("#content").first().getByText("Points earned")).toBeVisible();
  await expect(page.getByText(String(earned)).first()).toBeVisible();
  await openLearn(page);
  await expect(page.locator("#content").first().getByText("Best score 2/3")).toBeVisible();
});

/*
 * Learn this (consolidation Task 4.2): from a Notebook with one ready source,
 * the one primary action opens a sheet, Flashcards then Create with no count
 * chosen makes a deck sized from the source, and the deck appears in Results
 * and opens in place - no run to go and find, no navigation. CI runs this
 * against GENERATION_PROVIDER=fixture, whose flashcard answer quotes the
 * source's own sentences, so the verifier keeps every card.
 */

const NOTEBOOK_TITLE = "Learn this e2e notebook";
const NOTEBOOK_SOURCE_TITLE = "Learn this e2e source";
const NOTEBOOK_SOURCE_URL = "https://example.com/learn-this-e2e";
const NOTEBOOK_SOURCE_TEXT = [
  "The review queue settles each proposal with the gate's verdict.",
  "Every settle writes a receipt and an audit row in the same transaction.",
  "Agent surfaces cite each used library passage by its title.",
  "A notebook pins the source versions it was built from.",
  "Flashcards are scheduled per learner after each recall rating.",
  "A quiz sitting earns a stone only when two thirds are correct.",
].join(" ");

async function seedNotebookWithReadySource(): Promise<string | null> {
  const client = db();
  if (!client) return null;
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) return null;
    await removeSeededNotebook(client);
    const [notebook] = await client<{ id: string }[]>`
      insert into notebooks (workspace_id, title) values (${owner.workspace_id}, ${NOTEBOOK_TITLE}) returning id`;
    const [source] = await client<{ id: string }[]>`
      insert into sources (workspace_id, kind, title, url)
      values (${owner.workspace_id}, 'url', ${NOTEBOOK_SOURCE_TITLE}, ${NOTEBOOK_SOURCE_URL})
      returning id`;
    await client`
      insert into notebook_sources (workspace_id, notebook_id, source_id)
      values (${owner.workspace_id}, ${notebook.id}, ${source.id})`;
    const [doc] = await client<{ id: string }[]>`
      insert into documents (workspace_id, title, mime_type, source_url)
      values (${owner.workspace_id}, ${NOTEBOOK_SOURCE_TITLE}, 'text/plain', ${NOTEBOOK_SOURCE_URL})
      returning id`;
    // Read and indexed: the Sources pane says Ready, so Learn this uses it.
    const [extraction] = await client<{ id: string }[]>`
      insert into document_extractions (workspace_id, document_id, content_hash, status, text, spans, extractor, embedded_at)
      values (${owner.workspace_id}, ${doc.id}, 'e2e-learn-this', 'succeeded', ${NOTEBOOK_SOURCE_TEXT}, '[]'::jsonb, 'e2e@1', now())
      returning id`;
    await client`update documents set active_extraction_id = ${extraction.id} where id = ${doc.id}`;
    return notebook.id;
  } finally {
    await client.end();
  }
}

async function removeSeededNotebook(client: postgres.Sql): Promise<void> {
  // Decks, cards and reviews cascade from the notebook.
  await client`delete from notebooks where title = ${NOTEBOOK_TITLE}`;
  await client`delete from sources where url = ${NOTEBOOK_SOURCE_URL}`;
  await client`delete from documents where source_url = ${NOTEBOOK_SOURCE_URL}`;
}

test("Learn this: one primary action makes flashcards that open in place", async ({ page }) => {
  test.setTimeout(120_000);
  const notebookId = await seedNotebookWithReadySource();
  test.skip(!notebookId, "DATABASE_URL not configured (server and test).");
  try {
    // The project address opens its Notebook: no extra hop.
    await page.goto(`/projects/${notebookId}`);
    await expect(page).toHaveURL(new RegExp(`/projects/${notebookId}/notebook$`));
    await waitSettled(page);
    const content = page.locator("#content").first();

    // One primary action on the Notebook, and it is Learn this.
    const learnThis = content.getByRole("button", { name: "Learn this", exact: true });
    await expect(learnThis).toBeVisible();
    await expect(content.locator('[data-slot="button"][data-variant="default"]')).toHaveCount(1);

    await learnThis.click();
    const sheet = page.getByRole("dialog", { name: "Learn this" });
    await expect(sheet.getByText("Uses your 1 ready source.")).toBeVisible();
    await sheet.getByRole("radio", { name: /Flashcards/ }).check();
    await sheet.getByRole("button", { name: "Create", exact: true }).click();

    // The deck lands in Results as a card, sized from the source (5 or more).
    const results = content.getByRole("region", { name: "Results" });
    const deckCard = results.getByRole("article", { name: /flashcards/i });
    await expect(deckCard).toBeVisible({ timeout: 60_000 });
    const countText = await deckCard.getByText(/^\d+ cards$/).innerText();
    expect(Number.parseInt(countText, 10)).toBeGreaterThanOrEqual(5);

    // Opening it reviews the deck right here, on the Notebook.
    await deckCard.getByRole("button", { name: "Open" }).click();
    await expect(deckCard.getByText(/^Card 1 of \d+$/)).toBeVisible();
    await deckCard.getByRole("button", { name: "Show answer" }).click();
    await expect(deckCard.getByText("How well did you recall it?")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${notebookId}/notebook$`));
  } finally {
    const client = db();
    if (client) {
      try {
        await removeSeededNotebook(client);
      } finally {
        await client.end();
      }
    }
  }
});
