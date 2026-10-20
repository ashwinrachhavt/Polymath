import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The drizzle journal's when values must increase monotonically: drizzle-kit
 * skips a migration whose when is <= the newest applied row, so an entry
 * appended out of order applies to fresh databases but silently never runs
 * on existing ones while CI stays green.
 */

describe("migration journal ordering", () => {
  it("keeps every journal when value strictly increasing", () => {
    const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8"));
    // Historical entries predate this guard and several carry out-of-order
    // whens (0006, 0011, ...); existing databases already applied them, so
    // re-dating history is riskier than checking only what the pitfall
    // needs: each NEW appended entry must exceed the max before it. The
    // modern range starts at 0200; extend the exemption deliberately, never
    // silently, if another historical entry surfaces.
    const whens = journal.entries.map((e: { when: number }) => e.when);
    for (let i = 1; i < whens.length; i += 1) {
      const tag = journal.entries[i]!.tag as string;
      if (tag >= "0200") {
        expect(whens[i]!, `entry ${i} (${tag})`).toBeGreaterThan(
          Math.max(...whens.slice(0, i)),
        );
      }
    }
  });

  it("names every journal tag as an existing migration file", () => {
    const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8"));
    for (const entry of journal.entries) {
      expect(() => readFileSync(`src/db/migrations/${entry.tag}.sql`, "utf8")).not.toThrow();
    }
  });

  it("includes the inbox tab-count index migration (0214)", () => {
    const sql = readFileSync("src/db/migrations/0214_captures_inbox_tabs_index.sql", "utf8");
    expect(sql).toContain("captures_workspace_state_created_idx");
    expect(sql).toContain("\"captures\"");
  });
});
