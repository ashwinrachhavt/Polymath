import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * 0266_converge_push_schema heals any historical push-era schema to current.
 * Its statements are additive or catalog-guarded, so a second run must be a
 * no-op ON THE SCHEMA THE CHAIN PRODUCES: the second execution, composed with
 * the retirement drops, has to leave the schema exactly as the first
 * (replayed + retired) one did. That is the invariant that keeps a re-run
 * safe on prod — a converge that kept accumulating objects on every run
 * would drift a database it was meant to heal.
 *
 * The first run is deliberately NOT required to be a no-op. 0266 carries the
 * full historical chain's `CREATE TABLE IF NOT EXISTS` bodies, including
 * tables that later migrations retired (cards, areas, the sitting tables,
 * learning_*, the pre-rename dossier tables, and — since 0285/0286 — the
 * runtime trace tables and the other YAGNI-dropped tables). It also replays
 * 0248's dossier→notebook renames at its tail, and those renames are only
 * catalog-guarded against the target existing: with `notebook_questions`
 * retired by 0286, replaying 0266 renames the resurrected `dossier_questions`
 * back into `notebook_questions` — the exact flip that makes a bare
 * run-vs-run comparison unstable. Since 0269 the chain has therefore retired
 * what 0266 resurrects, and the invariant this test measures is the
 * composition: replay 0266, re-apply the retirement drops, and the schema is
 * back where the migration chain left it — byte for byte, every time.
 *
 * The script runs as one multi-statement simple query, the same way
 * drizzle-kit applies a migration; DO-block bodies never need splitting.
 */

const CONVERGE_FILE = "src/db/migrations/0266_converge_push_schema.sql";
/** The retirements that undo 0266's resurrected tables; re-applied as cleanup. */
const RETIREMENTS = [
  "src/db/migrations/0285_drop_dead_runtime_tables.sql",
  "src/db/migrations/0286_drop_zero_use_tables.sql",
  "src/db/migrations/0269_drop_retired_tables.sql",
  "src/db/migrations/0287_drop_zettel_proposals.sql",
];

/*
 * 0314 is not a pure drop (it creates llm_feedback and backfills it), so it
 * cannot be re-applied like the retirements above. This is its retirement half:
 * what 0266 resurrects that 0314 removed (artifact_feedback, run_events.feedback
 * and its check, the 'user_feedback' run_review_kind value and the index on it).
 * Every step is guarded, so it is a no-op on a schema 0266 did not touch.
 */
const RETIRE_0314 = `
  drop table if exists artifact_feedback;
  alter table run_events drop column if exists feedback;
  do $$ begin
    if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
               where t.typname = 'run_review_kind' and e.enumlabel = 'user_feedback') then
      drop index if exists run_reviews_one_feedback_per_run;
      drop index if exists run_reviews_one_critique_per_run;
      delete from run_reviews where kind = 'user_feedback';
      alter table run_reviews alter column kind type text;
      drop type run_review_kind;
      create type run_review_kind as enum ('critique');
      alter table run_reviews alter column kind type run_review_kind using kind::run_review_kind;
      create unique index run_reviews_one_critique_per_run on run_reviews using btree (workspace_id, run_id) where kind = 'critique';
    end if;
  end $$;
`;

/**
 * Replays 0266 as a database that has not yet run 0314 would see it: the
 * script's run_reviews index is on the 'user_feedback' value 0314 removed, and
 * a new enum value cannot be used in the transaction that adds it, so it is
 * added first, on its own.
 */
async function replayConverge(script: string): Promise<void> {
  await handle!.client.unsafe(`alter type run_review_kind add value if not exists 'user_feedback'`);
  await handle!.client.unsafe(script);
}

async function schemaSnapshot(sql: postgres.Sql): Promise<string> {
  const columns = await sql`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name
  `;
  const indexes = await sql`
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname
  `;
  const constraints = await sql`
    select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where connamespace = 'public'::regnamespace
    order by table_name, conname
  `;
  return JSON.stringify({ columns, indexes, constraints });
}

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

/** Re-apply the retirement drops so the schema is back where the chain left it. */
async function restoreHeadSchema(): Promise<void> {
  for (const retireFile of RETIREMENTS) {
    await handle!.client.unsafe(readFileSync(retireFile, "utf8"));
  }
  await handle!.client.unsafe(RETIRE_0314);
}

afterAll(async () => {
  // Put the database back where the migration chain left it, so every other
  // suite runs against the schema its migrations actually describe — without
  // this cleanup, a converge run early in the file order silently puts back
  // tables that tests/migration/schema-at-head.test.ts asserts are gone.
  if (handle) {
    await restoreHeadSchema();
  }
  await handle?.client.end();
});

suite("0266 converge idempotency", () => {
  it("settles after one run: the second leaves the schema byte-identical", async () => {
    if (!handle) throw new Error("unreachable");
    const script = readFileSync(CONVERGE_FILE, "utf8");
    expect(script).toContain("CREATE TABLE IF NOT EXISTS");

    await replayConverge(script);
    await restoreHeadSchema();
    const afterFirst = await schemaSnapshot(handle.client);
    await replayConverge(script);
    await restoreHeadSchema();
    const afterSecond = await schemaSnapshot(handle.client);

    // Convergence, not inertness: the replay is allowed to resurrect the
    // retired tables 0266 still carries creates for (the retirements drop
    // them again), but the composed second pass must change nothing or the
    // script is not idempotent on the schema the chain produces.
    expect(afterSecond).toBe(afterFirst);
  });
});
