import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JournalEntry = { idx: number; tag: string };
export type SnapshotInvariantState = { tracked: string[]; entries: JournalEntry[] };

const metaDir = "src/db/migrations/meta";
// The tag shape check-migrations.ts enforces; drizzle-kit names each snapshot
// after the tag's four-digit prefix (0270_learning_quizzes -> 0270_snapshot.json).
const tagPattern = /^\d{4}_[\w-]+$/;
const snapshotFile = /^\d{4}_snapshot\.json$/;

function snapshotBasename(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  return snapshotFile.test(base) ? base : null;
}

function isJournalEntry(entry: unknown): entry is JournalEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "idx" in entry &&
    typeof entry.idx === "number" &&
    "tag" in entry &&
    typeof entry.tag === "string"
  );
}

/*
 * The invariant the CI drift gate depends on: exactly one tracked snapshot,
 * and it is the journal's last entry. drizzle-kit generate diffs the domain
 * schemas against the lexicographically last snapshot present, falls back to
 * an empty baseline when none is, and aborts on a duplicate prevId
 * (drizzle-kit 0.31.11 preparePrevSnapshot / validateWithReport). Zero tracked
 * snapshots makes the drift gate emit a full-create migration; an older
 * tracked one emits a spurious catch-up migration — the gate turns red on
 * every PR either way. Only the newest snapshot is ever read, so the rest are
 * dead weight in every checkout. See src/db/migrations/README.md.
 */
export function checkSnapshotInvariant(state: SnapshotInvariantState): string[] {
  const last = state.entries[state.entries.length - 1];
  if (!last || !tagPattern.test(last.tag) || Number(last.tag.slice(0, 4)) !== last.idx) {
    const found = last ? `unreadable tag ${JSON.stringify(last.tag)}` : "the journal is empty";
    return [`Cannot derive the expected snapshot from ${metaDir}/_journal.json: ${found}.`];
  }
  const expected = `${last.tag.slice(0, 4)}_snapshot.json`;
  const tracked = state.tracked.map((path) => snapshotBasename(path)).filter((name): name is string => name !== null);
  const stale = tracked.filter((name) => name !== expected);

  if (tracked.length === 0) {
    return [
      `No drizzle snapshot is tracked under ${metaDir} — generate falls back to an empty baseline and the drift gate emits a full-create migration. ` +
        `Track exactly one, the journal's last entry's snapshot:\n` +
        `  git add -f ${metaDir}/${expected}\n` +
        `and flip the .gitignore exception line to the same name.`,
    ];
  }
  if (tracked.length > 1) {
    return [
      `${tracked.length} drizzle snapshots are tracked (${tracked.join(", ")}) — generate validates a prevId chain across all of them and diffs the newest. ` +
        `Track exactly one, the journal's last entry's snapshot:\n` +
        `  git rm --cached ${stale.map((name) => `${metaDir}/${name}`).join(" ")}\n` +
        `  git add -f ${metaDir}/${expected}\n` +
        `and keep a single .gitignore exception line for ${expected}.`,
    ];
  }
  if (tracked[0] !== expected) {
    return [
      `The tracked snapshot ${metaDir}/${tracked[0]} is not the journal's last entry's snapshot (${last.tag} -> ${expected}) — ` +
        `generate would diff against a stale schema and the drift gate emits a spurious catch-up migration. Track exactly one:\n` +
        `  git rm --cached ${metaDir}/${tracked[0]}\n` +
        `  git add -f ${metaDir}/${expected}\n` +
        `and flip the .gitignore exception line to ${expected}.`,
    ];
  }
  return [];
}

/*
 * Reads one state from disk: the journal, plus the snapshot basenames git
 * tracks. The CLI passes `git ls-files <metaDir>` output as trackedPaths so
 * tests can feed fixture lists without shelling out to git.
 */
export function readSnapshotState(metaDirectory: string, trackedPaths: string[]): SnapshotInvariantState {
  const raw: unknown = JSON.parse(readFileSync(resolve(metaDirectory, "_journal.json"), "utf8"));
  const entriesRaw = typeof raw === "object" && raw !== null && "entries" in raw ? raw.entries : undefined;
  const list: unknown[] = Array.isArray(entriesRaw) ? entriesRaw : [];
  return {
    tracked: trackedPaths.map((path) => snapshotBasename(path)).filter((name): name is string => name !== null),
    entries: list.filter(isJournalEntry),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tracked = execFileSync("git", ["ls-files", metaDir], { encoding: "utf8" }).split("\n");
  const errors = checkSnapshotInvariant(readSnapshotState(metaDir, tracked));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Snapshot invariant holds: exactly one tracked snapshot, the journal's last entry's.");
}
