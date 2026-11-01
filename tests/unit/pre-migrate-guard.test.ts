import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyDbState,
  journalHash,
  migrationsToBaseline,
  type DbProbe,
} from "../../scripts/pre-migrate-guard";

/*
 * The guard decides what the deploy's `pnpm db:migrate` does before
 * drizzle-kit touches the database. The classification is pure: these tests
 * pin the four states it must distinguish — journaled, fresh, push-era
 * (baseline), and ambiguous (fail loudly) — plus the baseline-set rule that
 * keeps post-converge migrations pending, and the journal hash format that
 * drizzle-kit compares positionally.
 */

function probe(overrides: Partial<DbProbe>): DbProbe {
  return {
    journalTableExists: false,
    journalRowCount: null,
    appTableCount: 0,
    missingCoreTables: ["workspaces", "agent_profiles"],
    ...overrides,
  };
}

describe("classifyDbState", () => {
  it("passes when the journal has applied migrations", () => {
    const decision = classifyDbState(probe({ journalTableExists: true, journalRowCount: 92 }));
    expect(decision.action).toBe("pass");
  });

  it("passes a fresh database through to the full replay", () => {
    const decision = classifyDbState(probe({ appTableCount: 0 }));
    expect(decision.action).toBe("pass");
    expect(decision.reason).toContain("fresh database");
  });

  it("passes when drizzle-kit created an empty journal on a fresh database", () => {
    const decision = classifyDbState(probe({ journalTableExists: true, journalRowCount: 0, appTableCount: 0 }));
    expect(decision.action).toBe("pass");
  });

  it("baselines a push-era schema: tables present, journal missing", () => {
    const decision = classifyDbState(probe({ appTableCount: 157, missingCoreTables: [] }));
    expect(decision.action).toBe("baseline");
    expect(decision.reason).toContain("push-era");
  });

  it("baselines the post-failure prod state: journal table exists but empty", () => {
    // drizzle-kit ensure-journal runs before the first migration applies, so a
    // crashed replay leaves an empty journal table behind the same schema.
    const decision = classifyDbState(
      probe({ journalTableExists: true, journalRowCount: 0, appTableCount: 157, missingCoreTables: [] }),
    );
    expect(decision.action).toBe("baseline");
  });

  it("fails loudly on an ambiguous schema: tables exist but core tables are missing", () => {
    // Baselining would mark the chain as applied while its base tables are
    // absent — a half-created database no guard can repair blind.
    const decision = classifyDbState(probe({ appTableCount: 3, missingCoreTables: ["workspaces"] }));
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("ambiguous");
  });
});

describe("migrationsToBaseline", () => {
  const entries = [
    { idx: 91, when: 1793687040000, tag: "0265_quota_reservation_refs" },
    { idx: 92, when: 1793687100000, tag: "0266_converge_push_schema" },
    { idx: 93, when: 1794000000000, tag: "0267_after_converge" },
  ];

  it("excludes the converge so migrate applies the healing for real", () => {
    // Baselining the converge would mark the healing as applied without
    // running it — the exact bug the E2E caught on a push-era replica.
    const baseline = migrationsToBaseline(entries);
    expect(baseline.map((entry) => entry.tag)).toEqual(["0265_quota_reservation_refs"]);
  });

  it("baselines everything published when the converge is absent", () => {
    const baseline = migrationsToBaseline(entries.slice(0, 1));
    expect(baseline).toHaveLength(1);
  });
});

describe("journalHash", () => {
  it("matches drizzle-kit's journal hash: sha256 of the migration file bytes", () => {
    const path = resolve(import.meta.dirname, "../../src/db/migrations/0000_extensions.sql");
    expect(journalHash("0000_extensions")).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
  });
});
