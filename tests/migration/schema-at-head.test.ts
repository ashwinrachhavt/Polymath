import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * The database these suites run against must be at the head of the migration
 * chain, not some older checkpoint that happens to still accept writes.
 *
 * This is the guard for a failure mode that cost a CI round trip: CI applies
 * every migration to a fresh database, a developer's long-lived axiom_test does
 * not, and the db/migration suites skip entirely when no database is
 * configured. The result was a local "all green" over a database two dozen
 * migrations stale — the converge-idempotency suite that would have caught the
 * problem was among the files being skipped.
 *
 * It asserts two things a drifted database cannot fake: the tables a retired
 * migration dropped are actually gone, and the column the head migration added
 * is actually present. Both are cheap and both are exactly what a stale
 * checkout gets wrong.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

/** The last migration in the journal — the one this guard tracks. */
function headTag(): string {
  const journal = JSON.parse(readFileSync(resolve(process.cwd(), "src/db/migrations/meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries[journal.entries.length - 1].tag;
}

afterAll(async () => {
  await handle?.client.end();
});

suite("test database is at the migration head", () => {
  it("has no table that a later migration dropped", async () => {
    if (!handle) throw new Error("unreachable");
    // Dropped by 0235 / 0257 / 0263 / 0268 / 0287. A database carrying any of
    // them is reading a schema the app has retired, and the suites over it
    // prove nothing.
    const retired = [
      "cards",
      "card_reviews",
      "areas",
      "zettel_sittings",
      "zettel_sitting_cards",
      "learning_attempts",
      "learning_items",
      "learning_decks",
      "learning_plans",
      "dossiers",
      "dossier_sources",
      "dossier_questions",
      "daily_outcomes",
      "zettel_proposals",
    ];
    const rows = await handle.client`
      select table_name::text as name from information_schema.tables
      where table_schema = 'public' and table_name = any(${retired})
      order by table_name
    `;
    expect(
      rows.map((row) => row.name),
      "Retired tables are present: this database is behind the chain. Run `pnpm test:ci` (rebuilds it from scratch, the same way CI does).",
    ).toEqual([]);
  });

  it("carries the column the head migration added", async () => {
    if (!handle) throw new Error("unreachable");
    const tag = headTag();
    // 0267 added this; keep the assertion tied to the reason, not the tag alone.
    const rows = await handle.client`
      select column_name::text as name from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_runs' and column_name = 'discarded_at'
    `;
    expect(
      rows.length,
      `agent_runs.discarded_at is missing, so this database predates 0267 (head is ${tag}). Run \`pnpm test:ci\`.`,
    ).toBe(1);
  });
});
