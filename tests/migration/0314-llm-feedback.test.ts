import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { flashcardDecks, quizzes } from "@/domains/learning/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import { seedReadDocument } from "../helpers/learning-fixtures";

/*
 * 0314 moves the three old rating stores into llm_feedback and drops them:
 * run_events.feedback ('up'/'down' on a reply), artifact_feedback
 * ('helpful'/'not_helpful' on a quiz, deck or artifact) and run_reviews'
 * user_feedback rows (the run-level verdict). A positive maps to 4, a negative
 * to 2, except a run's thumbs-down, which is the run-only 0. The static leg pins the order (create, backfill, then drop,
 * with no CASCADE). The dynamic leg recreates the two old stores at the chain
 * head inside a transaction, runs the file's own backfill statements against
 * seeded rows, checks what landed, and rolls back.
 */

const FILE = "src/db/migrations/0314_llm_feedback.sql";
const sqlText = readFileSync(FILE, "utf8");
const statements = sqlText.split("--> statement-breakpoint").map((statement) => statement.trim());
const backfills = statements.filter((statement) => /INSERT INTO "llm_feedback"/.test(statement));

const handle = makeTestDb();
let workspaceId: string;
let userId: string;
let runId: string;
let quizId: string;
let deckId: string;
let artifactId: string;

beforeAll(async () => {
  const { db } = handle;
  const seeded = await seedWorkspace(db, `m0314-${Date.now()}`);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: "polymath", createdBy: userId, updatedBy: userId })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "m0314",
      policySnapshot: {},
      state: "succeeded",
      model: "openai/gpt-old",
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  runId = run.id;
  const doc = await seedReadDocument(db, { userId, workspaceId, role: "owner" }, "text");
  [{ id: quizId }] = await db
    .insert(quizzes)
    .values({
      workspaceId,
      documentId: doc.documentId,
      sourceExtractionId: doc.extractionId,
      title: "Q",
      status: "ready",
      model: "quiz-model",
      promptVersion: "learn-quiz@6",
    })
    .returning({ id: quizzes.id });
  [{ id: deckId }] = await db
    .insert(flashcardDecks)
    .values({
      workspaceId,
      title: "D",
      sourceManifest: [],
      generationKey: `m0314-${Date.now()}`,
      model: "deck-model",
      promptVersion: "learning-flashcards@3",
    })
    .returning({ id: flashcardDecks.id });
  [{ id: artifactId }] = await db
    .insert(artifacts)
    .values({ workspaceId, title: "Idea", kind: "zettel", createdBy: userId, updatedBy: userId })
    .returning({ id: artifacts.id });
});

afterAll(async () => {
  await handle.client.end();
});

describe("0314 llm_feedback", () => {
  it("creates the table, backfills both old stores, then drops them without CASCADE", () => {
    const create = sqlText.indexOf('CREATE TABLE "llm_feedback"');
    const dropColumn = sqlText.indexOf('ALTER TABLE "run_events" DROP COLUMN "feedback"');
    const dropTable = sqlText.indexOf('DROP TABLE "artifact_feedback"');
    const dropVerdict = sqlText.indexOf('ALTER TABLE "run_reviews" DROP COLUMN "verdict"');
    expect(sqlText.indexOf('DELETE FROM "run_reviews" WHERE "kind" = \'user_feedback\'')).toBeLessThan(dropVerdict);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(backfills).toHaveLength(3);
    for (const statement of backfills) {
      const at = sqlText.indexOf(statement);
      expect(at).toBeGreaterThan(create);
      expect(at).toBeLessThan(dropColumn);
      expect(at).toBeLessThan(dropTable);
      expect(at).toBeLessThan(dropVerdict);
    }
    expect(sqlText).not.toMatch(/\bCASCADE\b/);
  });

  it("carries every old rating across as a 1-5 score with its provenance", async () => {
    const rollback = new Error("rollback");
    const landed = await handle.client
      .begin(async (sql) => {
        // IF NOT EXISTS: converge-idempotency.test.ts re-runs 0266, which recreates both.
        await sql`alter table run_events add column if not exists feedback text`;
        // The old run_reviews shape, with kind as text so the since-removed
        // 'user_feedback' value can be used inside this one transaction.
        await sql`alter table run_reviews rename to run_reviews_head`;
        await sql`create table run_reviews (
          workspace_id uuid not null, run_id uuid not null, kind text not null,
          verdict text, reasons text[] not null default '{}', note text,
          model text, profile_revision_id uuid, created_by uuid, updated_by uuid,
          created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
        await sql`create table if not exists artifact_feedback (
          id uuid primary key default gen_random_uuid(),
          workspace_id uuid not null, artifact_id uuid, quiz_id uuid, flashcard_deck_id uuid,
          user_id uuid not null, rating text not null,
          created_by uuid, updated_by uuid,
          created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
        const [up] = await sql<
          { id: string }[]
        >`insert into run_events (workspace_id, run_id, sequence, type, data, feedback)
          values (${workspaceId}, ${runId}, 1, 'message', ${JSON.stringify({ role: "assistant", content: "a" })}::jsonb, 'up') returning id`;
        const [down] = await sql<
          { id: string }[]
        >`insert into run_events (workspace_id, run_id, sequence, type, data, feedback)
          values (${workspaceId}, ${runId}, 2, 'message', ${JSON.stringify({ role: "assistant", content: "b" })}::jsonb, 'down') returning id`;
        await sql`insert into run_events (workspace_id, run_id, sequence, type, data)
          values (${workspaceId}, ${runId}, 3, 'message', ${JSON.stringify({ role: "assistant", content: "unrated" })}::jsonb)`;
        await sql`insert into artifact_feedback (workspace_id, quiz_id, user_id, rating, created_by, updated_by)
          values (${workspaceId}, ${quizId}, ${userId}, 'not_helpful', ${userId}, ${userId})`;
        await sql`insert into artifact_feedback (workspace_id, flashcard_deck_id, user_id, rating, created_by, updated_by)
          values (${workspaceId}, ${deckId}, ${userId}, 'helpful', ${userId}, ${userId})`;
        await sql`insert into artifact_feedback (workspace_id, artifact_id, user_id, rating, created_by, updated_by)
          values (${workspaceId}, ${artifactId}, ${userId}, 'helpful', ${userId}, ${userId})`;
        const runWith = async (objective: string) => {
          const [row] = await sql<
            { id: string }[]
          >`insert into agent_runs (workspace_id, agent_profile_id, objective, policy_snapshot, state, model, created_by, updated_by)
            select workspace_id, agent_profile_id, ${objective}, '{}'::jsonb, 'succeeded', 'run-model', ${userId}, ${userId} from agent_runs where id = ${runId} returning id`;
          return row.id;
        };
        const [runUp, runDown, runCleared] = [
          await runWith("rated up"),
          await runWith("rated down"),
          await runWith("cleared"),
        ];
        await sql`insert into run_reviews (workspace_id, run_id, kind, verdict, reasons, note, model, created_by, updated_by) values
          (${workspaceId}, ${runUp}, 'user_feedback', 'up', '{}', null, 'run-model', ${userId}, ${userId}),
          (${workspaceId}, ${runDown}, 'user_feedback', 'down', '{Wrong,Incomplete}', ' ignored the second file ', 'run-model', ${userId}, ${userId}),
          (${workspaceId}, ${runCleared}, 'user_feedback', null, '{}', null, 'run-model', ${userId}, ${userId})`;
        for (const statement of backfills) await sql.unsafe(statement);
        const rows = await sql<
          {
            surface: string;
            output_id: string;
            user_id: string;
            score: number;
            model: string | null;
            prompt_version: string | null;
          }[]
        >`select surface, output_id, user_id, score, model, prompt_version from llm_feedback
          where workspace_id = ${workspaceId} order by surface, score`;
        const runComments =
          await sql`select output_id, comment from llm_feedback where surface = 'run' and comment is not null and workspace_id = ${workspaceId}`;
        throw Object.assign(rollback, { rows, runComments, up: up.id, down: down.id, runUp, runDown });
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
        return error as Error & {
          rows: unknown[];
          runComments: unknown[];
          up: string;
          down: string;
          runUp: string;
          runDown: string;
        };
      });
    expect(landed.rows).toEqual([
      { surface: "artifact", output_id: artifactId, user_id: userId, score: 4, model: null, prompt_version: null },
      {
        surface: "chat",
        output_id: landed.down,
        user_id: userId,
        score: 2,
        model: "openai/gpt-old",
        prompt_version: null,
      },
      {
        surface: "chat",
        output_id: landed.up,
        user_id: userId,
        score: 4,
        model: "openai/gpt-old",
        prompt_version: null,
      },
      {
        surface: "flashcards",
        output_id: deckId,
        user_id: userId,
        score: 4,
        model: "deck-model",
        prompt_version: "learning-flashcards@3",
      },
      {
        surface: "quiz",
        output_id: quizId,
        user_id: userId,
        score: 2,
        model: "quiz-model",
        prompt_version: "learn-quiz@6",
      },
      // A run's thumbs-down is 0, a thumbs-up 4, and a cleared verdict is not carried.
      {
        surface: "run",
        output_id: landed.runDown,
        user_id: userId,
        score: 0,
        model: "run-model",
        prompt_version: null,
      },
      { surface: "run", output_id: landed.runUp, user_id: userId, score: 4, model: "run-model", prompt_version: null },
    ]);
    // The reason chips and the line become the comment.
    expect(landed.runComments).toEqual([
      { output_id: landed.runDown, comment: "Wrong, Incomplete: ignored the second file" },
    ]);
  });
});
