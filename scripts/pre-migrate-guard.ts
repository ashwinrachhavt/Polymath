/*
 * Pre-migrate guard: heal push-era databases before drizzle-kit migrate runs.
 *
 * Production's schema was created by `drizzle-kit push`, which writes no
 * journal. The first deploy-time `drizzle-kit migrate` therefore saw an empty
 * journal, replayed from 0000, and crashed on an existing relation (drizzle-kit
 * 0.31 swallows the error text and exits 1). The build runs this guard first:
 *
 *   journal present with rows          -> pass, drizzle-kit resumes normally
 *   no journal and no app tables       -> pass, fresh database, full replay is correct
 *   journal missing/empty, app schema  -> baseline the journal for the
 *                                         pre-existing chain, then migrate applies
 *                                         only the pending tail
 *   journal missing/empty, partial app
 *   schema (no core tables)            -> exit 1: cannot tell how much of the
 *                                         chain is present; baselining could
 *                                         mark unapplied tables as applied
 *
 * Baseline rows are only ever written when the journal is empty, inside a
 * transaction guarded by an advisory lock, so concurrent builds and re-runs
 * are no-ops.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

export const JOURNAL_SCHEMA = "drizzle";
export const JOURNAL_TABLE = "drizzle.__drizzle_migrations";
// The converge migration heals any push-era schema to current. Everything up to
// and including it describes effects a push-created database may already have;
// anything after it must stay pending so migrate applies it for real.
export const CONVERGE_TAG = "0266_converge_push_schema";
// Tables created by 0001: their presence (without a journal) identifies a
// push-era database. A crashed half-migrate would leave some of them missing.
export const CORE_TABLES = ["workspaces", "agent_profiles"] as const;
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../src/db/migrations");

export type JournalEntry = { idx: number; when: number; tag: string };

export type DbProbe = {
  journalTableExists: boolean;
  journalRowCount: number | null;
  appTableCount: number;
  missingCoreTables: string[];
};

export type GuardDecision =
  | { action: "pass"; reason: string }
  | { action: "baseline"; reason: string }
  | { action: "fail"; reason: string };

export function classifyDbState(probe: DbProbe): GuardDecision {
  if (probe.journalTableExists && (probe.journalRowCount ?? 0) > 0) {
    return {
      action: "pass",
      reason: `journal has ${probe.journalRowCount} applied migrations — drizzle-kit resumes normally`,
    };
  }
  if (probe.appTableCount === 0) {
    return {
      action: "pass",
      reason: "no journal and no application tables — fresh database; the full replay is the correct migrate",
    };
  }
  if (probe.missingCoreTables.length === 0) {
    return {
      action: "baseline",
      reason: `${probe.appTableCount} application tables exist without a journal entry — push-era schema; baselining ${JOURNAL_TABLE}`,
    };
  }
  return {
    action: "fail",
    reason: `ambiguous schema state: ${probe.appTableCount} tables exist but core tables are missing (${probe.missingCoreTables.join(", ")}) — a baselined migrate would mark unapplied tables as applied. Inspect this database manually.`,
  };
}

// Baseline set: the published chain UP TO BUT EXCLUDING the converge. The
// converge is the migration that heals a push-era schema to current, so it
// must stay pending and be applied by drizzle-kit for real; only the entries
// before it describe effects a push-created database may already have.
export function migrationsToBaseline(entries: JournalEntry[]): JournalEntry[] {
  const convergeIndex = entries.findIndex((entry) => entry.tag === CONVERGE_TAG);
  return convergeIndex === -1 ? entries : entries.slice(0, convergeIndex);
}

// Confirmed empirically against a fresh migrate: the journal's hash column is
// the sha256 of the migration file's bytes, and created_at is the journal's
// `when` value. drizzle-kit compares hashes positionally, so both must match
// byte-for-byte or the next migrate replays.
export function journalHash(tag: string): string {
  return createHash("sha256").update(readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`))).digest("hex");
}

async function probe(client: postgres.Sql): Promise<DbProbe> {
  const journal = await client`select to_regclass(${JOURNAL_TABLE}) as reg`;
  const journalTableExists = journal[0]?.reg !== null;
  const journalRowCount = journalTableExists
    ? Number((await client`select count(*) as count from ${client(JOURNAL_TABLE.split(".")[0])}.${client(JOURNAL_TABLE.split(".")[1])}`)[0].count)
    : null;
  const appTables = await client`
    select count(*)::int as count from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `;
  const core = await client`
    select table_name::text as name from information_schema.tables
    where table_schema = 'public' and table_name = any(${CORE_TABLES})
  `;
  const present = new Set(core.map((row) => row.name));
  return {
    journalTableExists,
    journalRowCount,
    appTableCount: appTables[0].count,
    missingCoreTables: CORE_TABLES.filter((table) => !present.has(table)),
  };
}

async function baseline(client: postgres.Sql, entries: JournalEntry[]): Promise<number> {
  await client.begin(async (tx) => {
    // One writer at a time; concurrent builds serialize here and the re-check
    // below makes the second one a no-op.
    await tx`select pg_advisory_xact_lock(hashtext('polymath:pre-migrate-guard'))`;
    // The journal table may not exist yet (that is the push-era case this
    // guard heals), so probe with to_regclass before counting.
    const journal = await tx`select to_regclass(${JOURNAL_TABLE}) is not null as exists`;
    if (journal[0].exists) {
      const existing = await tx`select count(*)::int as count from ${tx(JOURNAL_SCHEMA)}.${tx("__drizzle_migrations")}`;
      if (existing[0].count > 0) {
        console.log(`pre-migrate-guard: journal now has ${existing[0].count} rows (another process baselined it) — nothing to do`);
        return;
      }
    }
    await tx`create schema if not exists ${tx(JOURNAL_SCHEMA)}`;
    await tx`
      create table if not exists ${tx(JOURNAL_SCHEMA)}.${tx("__drizzle_migrations")} (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    for (const entry of entries) {
      await tx`insert into ${tx(JOURNAL_SCHEMA)}.${tx("__drizzle_migrations")} (hash, created_at) values (${journalHash(entry.tag)}, ${entry.when})`;
    }
    console.log(`pre-migrate-guard: baselined ${entries.length} journal entries for the push-era schema`);
  });
  return entries.length;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // Same contract as drizzle.config.ts: the build fails loudly rather than
    // deploying code that cannot reach its database.
    console.error("pre-migrate-guard: DATABASE_URL is not set — the build cannot migrate. Expose it to the build environment.");
    process.exitCode = 1;
    return;
  }
  const client = postgres(url, { max: 1 });
  try {
    const decision = classifyDbState(await probe(client));
    if (decision.action === "fail") {
      console.error(`pre-migrate-guard: ${decision.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`pre-migrate-guard: ${decision.reason}`);
    if (decision.action === "pass") return;
    const journal = JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    };
    await baseline(client, migrationsToBaseline(journal.entries));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    () => undefined,
    (error) => {
      console.error("pre-migrate-guard failed:", error);
      process.exitCode = 1;
    },
  );
}
