import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSnapshotInvariant, readSnapshotState } from "../../scripts/check-snapshot-invariant";

/*
 * The invariant the CI drift gate depends on: exactly one tracked snapshot,
 * and it is the journal's last entry. These tests pin the four states it must
 * distinguish — correct baseline, none tracked, several tracked, wrong one
 * tracked — plus journal parsing on real fixture dirs, so a broken checkout
 * fails the guard with instructions instead of red-flaking the drift gate.
 */

const lastEntry = { idx: 270, when: 1793687340000, tag: "0270_learning_quizzes" };
const earlierEntry = { idx: 268, when: 1793687220000, tag: "0268_repo_checkpoints" };

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "snapshot-invariant-"));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeJournal(entries: { idx: number; when?: number; tag: string }[]) {
  writeFileSync(join(fixtureDir, "_journal.json"), JSON.stringify({ version: "7", entries }));
}

describe("checkSnapshotInvariant", () => {
  it("passes when exactly the journal's last entry's snapshot is tracked", () => {
    writeJournal([earlierEntry, lastEntry]);
    const errors = checkSnapshotInvariant({
      tracked: ["src/db/migrations/meta/0270_snapshot.json"],
      entries: [earlierEntry, lastEntry],
    });
    expect(errors).toEqual([]);
  });

  it("fails when no snapshot is tracked, naming the one to add", () => {
    writeJournal([lastEntry]);
    const errors = checkSnapshotInvariant({ tracked: ["src/db/migrations/meta/_journal.json"], entries: [lastEntry] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("No drizzle snapshot is tracked");
    expect(errors[0]).toContain("0270_snapshot.json");
    expect(errors[0]).toContain("git add -f");
  });

  it("fails when a second snapshot is tracked, naming the ones to drop", () => {
    writeJournal([earlierEntry, lastEntry]);
    const errors = checkSnapshotInvariant({
      tracked: ["src/db/migrations/meta/0268_snapshot.json", "src/db/migrations/meta/0270_snapshot.json"],
      entries: [earlierEntry, lastEntry],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 drizzle snapshots are tracked");
    expect(errors[0]).toContain("0268_snapshot.json");
    expect(errors[0]).toContain("git rm --cached");
  });

  it("fails when the tracked snapshot is older than the journal's last entry", () => {
    writeJournal([earlierEntry, lastEntry]);
    const errors = checkSnapshotInvariant({ tracked: ["0268_snapshot.json"], entries: [earlierEntry, lastEntry] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("is not the journal's last entry's snapshot");
    expect(errors[0]).toContain("0270_learning_quizzes");
  });

  it("fails when the tracked snapshot has no journal entry behind it", () => {
    writeJournal([lastEntry]);
    const errors = checkSnapshotInvariant({ tracked: ["0271_snapshot.json"], entries: [lastEntry] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("0271_snapshot.json");
    expect(errors[0]).toContain("0270_snapshot.json");
  });

  it("fails loudly when the journal's last entry cannot be read", () => {
    const errors = checkSnapshotInvariant({ tracked: ["0270_snapshot.json"], entries: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Cannot derive the expected snapshot");
  });
});

describe("readSnapshotState", () => {
  it("reads a fixture dir's journal and keeps only snapshot basenames from the git listing", () => {
    writeJournal([earlierEntry, lastEntry]);
    const state = readSnapshotState(fixtureDir, [
      "src/db/migrations/meta/0268_snapshot.json",
      "src/db/migrations/meta/0270_snapshot.json",
      "src/db/migrations/meta/_journal.json",
      "src/db/migrations/0270_learning_quizzes.sql",
    ]);
    expect(state.tracked).toEqual(["0268_snapshot.json", "0270_snapshot.json"]);
    expect(state.entries).toEqual([earlierEntry, lastEntry]);
  });

  it("filters malformed journal entries instead of crashing the guard", () => {
    writeFileSync(
      join(fixtureDir, "_journal.json"),
      JSON.stringify({ version: "7", entries: [{ idx: "oops" }, null, lastEntry] }),
    );
    const state = readSnapshotState(fixtureDir, ["0270_snapshot.json"]);
    expect(state.entries).toEqual([lastEntry]);
    expect(checkSnapshotInvariant(state)).toEqual([]);
  });

  it("treats a journal of the wrong shape as empty, so the guard fails loudly", () => {
    writeFileSync(join(fixtureDir, "_journal.json"), JSON.stringify({ entries: "not-a-list" }));
    const state = readSnapshotState(fixtureDir, ["0270_snapshot.json"]);
    expect(state.entries).toEqual([]);
    expect(checkSnapshotInvariant(state)[0]).toContain("Cannot derive the expected snapshot");
  });
});
