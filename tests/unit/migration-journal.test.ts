import { describe, expect, it } from "vitest";
import { checkMigrations, type MigrationState } from "../../scripts/check-migrations";

// Existing non-monotonic checkpoints stay intact. Only new migrations must
// exceed the largest applied timestamp, regardless of lane/file numbering.
const base: MigrationState = {
  entries: [{ idx: 1, tag: "0001_first", when: 30 }, { idx: 2, tag: "0002_legacy", when: 20 }],
  sql: { "0001_first": "select 1;", "0002_legacy": "select 2;" },
};
const append = (when = 31): MigrationState => ({
  entries: [...base.entries, { idx: 10, tag: "0010_next", when }],
  sql: { ...base.sql, "0010_next": "select 3;" },
});

describe("migration checkpoint guard", () => {
  it("accepts unchanged legacy history and safe append", () => {
    expect(checkMigrations(base, base)).toEqual([]);
    expect(checkMigrations(append(), base)).toEqual([]);
  });
  it("rejects a new checkpoint below or equal to the historical maximum", () => {
    for (const when of [21, 30]) expect(checkMigrations(append(when), base).join()).toContain("when > 30");
  });
  it("rejects reordered or rewritten published journal entries", () => {
    expect(checkMigrations({ ...base, entries: [...base.entries].reverse() }, base).join()).toContain("Published journal entry changed");
    const state = append();
    state.entries = [{ ...base.entries[0], when: 19 }, ...state.entries.slice(1)];
    expect(checkMigrations(state, base).join()).toContain("Published journal entry changed");
  });
  it("rejects changed or deleted published SQL", () => {
    expect(checkMigrations({ ...base, sql: { ...base.sql, "0001_first": "drop table users;" } }, base).join()).toContain("Published SQL changed");
    expect(checkMigrations({ ...base, sql: {} }, base).join()).toContain("Published SQL removed");
  });
  it("rejects orphan SQL, missing SQL, collisions and invalid metadata", () => {
    expect(checkMigrations({ ...base, sql: { ...base.sql, orphan: "select 1;" } }, base).join()).toContain("no journal entry");
    expect(checkMigrations({ ...append(), sql: base.sql }, base).join()).toContain("Missing SQL");
    expect(checkMigrations({ ...base, entries: [...base.entries, base.entries[0]] }, base).join()).toContain("Duplicate");
    const state = append();
    state.entries[2] = { idx: 11, tag: "../escape", when: NaN };
    expect(checkMigrations(state, base).join()).toContain("Invalid");
  });
  it("checks each appended entry, not only the final one", () => {
    const state = append(40);
    state.entries.push({ idx: 11, tag: "0011_later", when: 35 });
    state.sql["0011_later"] = "select 4;";
    expect(checkMigrations(state, base).join()).toContain("when > 40");
  });
});
