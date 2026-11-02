import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TrackedBlob = { path: string; bytes: number };
export type RepoHygieneState = { files: TrackedBlob[] };

// One byte over this fails the guard; the unit tests and the CI self-test pin
// both sides of the boundary.
export const SIZE_CEILING_BYTES = 256 * 1024;

// Deny-by-default: a blob over the ceiling is tracked only when one of these
// path-anchored globs matches it (`dir/**` spans any segments below dir, `*`
// stays within one segment). A new large file needs a deliberate line here —
// that friction is the point. See docs/repo-hygiene.md.
export const SIZE_ALLOWLIST: readonly string[] = [
  "pnpm-lock.yaml",
  "src/db/migrations/**",
  "src/db/migrations/meta/*_snapshot.json",
  "tests/fixtures/**",
  "extensions/**",
];

// Machine-local output that must never be tracked at any size, at any depth:
// a trailing-slash entry matches any path with that segment, a plain name
// matches any basename, a starred name matches any basename. Snapshot
// multiplicity is deliberately absent — the snapshot-invariant guard owns it.
export const GENERATED_BLOCKLIST: readonly string[] = [
  ".next/",
  "build/",
  "coverage/",
  "dist/",
  ".turbo/",
  ".DS_Store",
  "*.tsbuildinfo",
];

/*
 * Minimal glob for exactly the two wildcard forms the allowlist uses: `**`
 * spans segments, a lone `*` stays within one, everything else is literal.
 * Five literal lines — not worth a glob dependency.
 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]|\*{1,2}/g, (token) => {
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    return `\\${token}`;
  });
  return new RegExp(`^${source}$`);
}

function allowlistMatches(path: string): boolean {
  return SIZE_ALLOWLIST.some((pattern) => globToRegExp(pattern).test(path));
}

/*
 * Blocklist entries are gitignore-style names, not anchored globs: `dist/`
 * catches packages/app/dist/… as readily as a top-level dist/.
 */
function blocklistMatches(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? path;
  return GENERATED_BLOCKLIST.some((pattern) => {
    if (pattern.endsWith("/")) return segments.includes(pattern.slice(0, -1));
    if (pattern.includes("*")) return globToRegExp(pattern).test(base);
    return base === pattern;
  });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString("en-US")} bytes)`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString("en-US")} bytes)`;
}

/*
 * The bloat guard: generated output and oversized blobs stay out of the repo
 * by structure, not memory. Blocklist first (a tracked build artifact fails
 * even when small); the size ceiling applies everywhere else, unless an
 * allowlist line claims the path. One error per violating file, each with the
 * recipe to fix it. See docs/repo-hygiene.md.
 */
export function checkRepoHygiene(state: RepoHygieneState): string[] {
  const errors: string[] = [];
  for (const { path, bytes } of state.files) {
    if (blocklistMatches(path)) {
      errors.push(
        `Generated/local artifact is tracked: ${path} — remove it with git rm --cached ${path} ` +
          `and keep it out of commits (see docs/repo-hygiene.md).`,
      );
      continue;
    }
    if (bytes > SIZE_CEILING_BYTES && !allowlistMatches(path)) {
      errors.push(
        `${path} is ${fmtBytes(bytes)} — over the ${fmtBytes(SIZE_CEILING_BYTES)} tracked-blob ceiling. ` +
          `Trim, compress, or generate it locally instead of committing it; if it is legitimately large, ` +
          `add a path-anchored line to SIZE_ALLOWLIST in scripts/check-repo-hygiene.ts (deny-by-default: ` +
          `a new large file needs a deliberate allowlist line).`,
      );
    }
  }
  return errors;
}

/*
 * Reads tracked blobs from the git index — `git ls-files --stage` lists every
 * staged path with its blob SHA, and one `git cat-file --batch-check` resolves
 * the sizes. The index (not HEAD) is the honest surface: it is what a commit
 * would carry, so a violation fails before it pushes. repoRoot is injectable
 * so tests can drive it against fixture repos instead of this checkout.
 */
export function readTrackedBlobs(repoRoot: string = process.cwd()): TrackedBlob[] {
  // -z: records are NUL-separated so paths survive verbatim; each record is
  // "<mode> <sha> <stage>\t<path>".
  const index = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repoRoot, encoding: "utf8" });
  const entries: { path: string; sha: string }[] = [];
  for (const record of index.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error(`repo-hygiene: unreadable git ls-files entry: ${JSON.stringify(record)}`);
    const [mode, sha, stage] = record.slice(0, tab).split(" ");
    if (!mode || !sha || !stage)
      throw new Error(`repo-hygiene: unreadable git ls-files entry: ${JSON.stringify(record)}`);
    if (stage !== "0") continue; // merge-conflict stages are not settled content
    entries.push({ path: record.slice(tab + 1), sha });
  }

  const sizes = blobSizes([...new Set(entries.map((entry) => entry.sha))], repoRoot);
  return entries.map(({ path, sha }) => {
    const bytes = sizes.get(sha);
    if (bytes === undefined)
      throw new Error(`repo-hygiene: no size resolved for ${path} (${sha}) — is the object database intact?`);
    return { path, bytes };
  });
}

function blobSizes(shas: string[], repoRoot: string): Map<string, number> {
  const sizes = new Map<string, number>();
  if (shas.length === 0) return sizes;
  const out = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: shas.join("\n"),
  });
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, type, size] = line.split(" ");
    if (!sha || !type || !size) throw new Error(`repo-hygiene: unreadable git cat-file line: ${line}`);
    if (type === "missing") throw new Error(`repo-hygiene: the index references a missing object: ${sha}`);
    if (type !== "blob") continue; // submodule gitlinks carry no file size
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`repo-hygiene: unreadable blob size for ${sha}: ${size}`);
    }
    sizes.set(sha, bytes);
  }
  return sizes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = readTrackedBlobs();
  const errors = checkRepoHygiene({ files });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Repo hygiene holds: ${files.length} tracked files, none blocklisted, none over the ${fmtBytes(SIZE_CEILING_BYTES)} ceiling outside the allowlist.`,
    );
  }
}
