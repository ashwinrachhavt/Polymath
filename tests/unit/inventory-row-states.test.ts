import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { GUARDED_WITHOUT_VERSION, VERSIONED_WITH_TRIGGER_INVARIANT, readTables } from "../../scripts/lib/row-state";
import type { Guard } from "../../scripts/lib/row-state";

/*
 * D-3 / D-9: the row rule (docs/tech-spec-v2.md §3).
 *
 * A mutable row either carries `version` and is written through a guarded update,
 * or it is append-only, or its concurrency is handled by mechanisms declared with
 * what they do and where to check it. A new mutable table with none fails here by
 * name.
 *
 * Deliberately NOT a re-run of the classifier: that would only prove the test
 * agrees with the generator. The classifier decides the shape; this asserts what
 * shape cannot know — that a human read the write path, and that a claimed trigger
 * actually guards the columns it says it guards.
 */

const ROOT = join(__dirname, "..", "..");
const tables = readTables(ROOT);
const allGuardTables = { ...GUARDED_WITHOUT_VERSION, ...VERSIONED_WITH_TRIGGER_INVARIANT };

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkSource(path, acc);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) acc.push(path);
  }
  return acc;
}

/** The plpgsql body of the trigger function guarding `table`, or null. */
function triggerBody(migrationPath: string, table: string): string | null {
  const sql = readFileSync(join(ROOT, migrationPath), "utf8");
  const created = new RegExp(`CREATE TRIGGER\\s+"[a-z_]*"\\s+BEFORE UPDATE ON\\s+"${table}"`, "i");
  if (!created.test(sql)) return null;
  // The function is declared before the trigger; take the nearest preceding function body.
  const before = sql.slice(0, sql.search(created));
  const fnStart = before.lastIndexOf("CREATE FUNCTION");
  if (fnStart === -1) return null;
  return before.slice(fnStart);
}

describe("row-state rule", () => {
  it("reads the schema it is meant to check", () => {
    expect(tables.length).toBeGreaterThan(100);
  });

  it("leaves no mutable table without a version column or a declared guard", () => {
    const undeclared = tables
      .filter((t) => t.state === "mutable-unversioned" && !GUARDED_WITHOUT_VERSION[t.key])
      .map((t) => `${t.key}: add \`version\` via ...mutable, or declare its guard in scripts/lib/row-state.ts`);
    expect(undeclared).toEqual([]);
  });

  it("declares nothing that has since gained a version column", () => {
    const stale = Object.keys(GUARDED_WITHOUT_VERSION).filter((key) => {
      const table = tables.find((t) => t.key === key);
      return !table || table.state !== "mutable-unversioned";
    });
    expect(stale).toEqual([]);
  });

  it("cites a file that exists for every guard", () => {
    const missing = Object.entries(allGuardTables)
      .flatMap(([key, decl]) => decl.guards.map((g) => ({ key, g })))
      .filter(({ g }) => !existsSync(join(ROOT, g.evidence.split(":")[0])))
      .map(({ key, g }) => `${key} cites ${g.evidence}, which does not exist`);
    expect(missing).toEqual([]);
  });

  it("describes every guard and uses a known kind", () => {
    for (const [key, decl] of Object.entries(allGuardTables)) {
      for (const g of decl.guards) {
        expect(g.detail.length, `${key} has a guard with no detail`).toBeGreaterThan(20);
        expect(["atomic-counter", "app-cas", "trigger-immutable", "lease"], `${key} has an unknown guard kind`).toContain(g.kind);
      }
    }
  });

  it("backs every trigger claim with a trigger that touches the named columns", () => {
    const claims = Object.entries(allGuardTables)
      .flatMap(([key, decl]) => decl.guards.filter((g) => g.kind === "trigger-immutable").map((g) => ({ key, g })));
    expect(claims.length, "expected at least one trigger-backed declaration").toBeGreaterThan(0);

    for (const { key, g } of claims) {
      const [path] = g.evidence.split(":");
      const table = key.split(".")[1];
      const body = triggerBody(path, table);
      expect(body, `${key} claims a trigger but ${path} has none on "${table}"`).not.toBeNull();
      expect(g.columns?.length, `${key} claims a trigger but names no columns`).toBeGreaterThan(0);
      for (const column of g.columns!) {
        expect(body!.includes(`"${column}"`) || body!.includes(`.${column}`), `${key}: trigger does not reference "${column}"`).toBe(true);
      }
    }
  });

  it("does not claim a trigger for tables whose trigger ignores that column", () => {
    // The specific error this catches: runtime_signals' trigger freezes payload but
    // not status, so claiming it guards the state machine would be false.
    const runtimeSignals = GUARDED_WITHOUT_VERSION["agents.runtime_signals"];
    const trigger = runtimeSignals.guards.find((g: Guard) => g.kind === "trigger-immutable");
    expect(trigger).toBeDefined();
    const body = triggerBody("src/db/migrations/0150_runtime_persistence.sql", "runtime_signals")!;
    expect(body.includes('"status"'), "runtime_signals trigger unexpectedly guards status — revisit its app-cas declaration").toBe(false);
  });

  /*
   * A lease protects the writer, not the row. Nothing in the database stops a
   * second caller that never takes it, so it only counts as a guard while it is
   * the single entry path. That is a property of the call graph, which means it
   * can be asserted rather than asserted-in-prose. Fails closed: an undeclared
   * lease is a failure, and a new production caller is a failure.
   */
  it("backs every lease with a demonstrated single entry path", () => {
    const leases = Object.entries(allGuardTables)
      .flatMap(([key, decl]) => decl.guards.filter((g) => g.kind === "lease").map((g) => ({ key, g })));
    expect(leases.length, "expected at least one lease-guarded declaration").toBeGreaterThan(0);

    for (const { key, g } of leases) {
      expect(g.singleEntryPath, `${key} declares a lease with no singleEntryPath — fails closed`).toBeDefined();
      const declared = g.singleEntryPath!.callers;
      expect(Object.keys(declared).length, `${key} names no entry functions`).toBeGreaterThan(0);

      for (const [fn, permitted] of Object.entries(declared)) {
        /*
         * A static scan, not a call graph. It cannot see a caller reached through a
         * variable, a re-export, or a dynamic import, and it deliberately ignores
         * tests/. That is the ceiling of this check: it is strong evidence for a
         * single entry path, not proof. Permission is per function rather than per
         * file on purpose - a file allowed to call the leased path is not thereby
         * allowed to call the one that bypasses the lease.
         */
        const callers = walkSource(join(ROOT, "src")).filter((file) => {
          const text = readFileSync(file, "utf8");
          if (!new RegExp(`\\b${fn}\\s*\\(`).test(text)) return false;
          // Declaration sites do not count as callers.
          return !new RegExp(`(export )?(async )?function ${fn}\\s*\\(`).test(text);
        });
        const stray = callers.map((f) => relative(ROOT, f)).filter((f) => !permitted.includes(f));
        expect(
          stray,
          permitted.length === 0
            ? `${key}: ${fn} was declared as having no production caller, but ${stray.join(", ")} calls it — the lease is no longer the only entry path`
            : `${key}: ${fn} has callers outside the declared path`,
        ).toEqual([]);
      }
    }
  });
});
