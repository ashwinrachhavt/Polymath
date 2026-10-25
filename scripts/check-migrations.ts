import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Entry = { idx: number; when: number; tag: string };
export type MigrationState = { entries: Entry[]; sql: Record<string, string> };
const directory = "src/db/migrations";

// Published history can be imperfect, but must never be rewritten to repair
// ordering: an applied timestamp is a database checkpoint, not a file date.
export function checkMigrations(current: MigrationState, base: MigrationState): string[] {
  const errors: string[] = [];
  const tags = new Set<string>();
  const indices = new Set<number>();
  let checkpoint = Math.max(0, ...base.entries.map((entry) => entry.when));
  for (const [position, entry] of current.entries.entries()) {
    if (!Number.isSafeInteger(entry.idx) || !Number.isSafeInteger(entry.when)) errors.push(`Invalid idx/when: ${entry.tag}`);
    if (!/^\d{4}_[\w-]+$/.test(entry.tag) || Number(entry.tag.slice(0, 4)) !== entry.idx) errors.push(`Invalid migration tag/idx: ${entry.tag}`);
    if (tags.has(entry.tag) || indices.has(entry.idx)) errors.push(`Duplicate migration: ${entry.tag}`);
    tags.add(entry.tag);
    indices.add(entry.idx);
    if (!(entry.tag in current.sql)) errors.push(`Missing SQL: ${entry.tag}`);
    if (position >= base.entries.length) {
      if (entry.when <= checkpoint) errors.push(`New migration ${entry.tag} must have when > ${checkpoint}`);
      checkpoint = entry.when;
    }
  }
  for (const [position, entry] of base.entries.entries()) {
    if (JSON.stringify(current.entries[position]) !== JSON.stringify(entry)) errors.push(`Published journal entry changed: ${entry.tag}`);
  }
  for (const [tag, sql] of Object.entries(current.sql)) {
    if (!tags.has(tag)) errors.push(`SQL has no journal entry: ${tag}`);
    if (tag in base.sql && base.sql[tag] !== sql) errors.push(`Published SQL changed: ${tag}`);
  }
  // The base's SQL set is keyed by loose files, but only journal entries are
  // published checkpoints: a file merged without a journal entry (0225 was)
  // never ran on any database, so deleting it repairs history rather than
  // rewriting it.
  const baseTags = new Set(base.entries.map((entry) => entry.tag));
  for (const tag of Object.keys(base.sql)) {
    if (tag in current.sql) continue;
    if (baseTags.has(tag)) errors.push(`Published SQL removed: ${tag}`);
  }
  return errors;
}

function readState(ref?: string): MigrationState {
  const read = (path: string) => ref
    ? execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" })
    : readFileSync(path, "utf8");
  const files = ref
    ? execFileSync("git", ["ls-tree", "--name-only", ref, `${directory}/`], { encoding: "utf8" }).trim().split("\n")
    : readdirSync(directory).map((name) => `${directory}/${name}`);
  return {
    entries: JSON.parse(read(`${directory}/meta/_journal.json`)).entries,
    sql: Object.fromEntries(files.filter((file) => file.endsWith(".sql")).map((file) => [file.split("/").pop()!.slice(0, -4), read(file)])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: pnpm check:migrations <base-ref>. Fetch the target branch first.");
  const errors = checkMigrations(readState(), readState(base));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Migration history preserved; new entries are complete and checkpoint-safe.");
}
