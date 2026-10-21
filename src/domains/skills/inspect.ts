import { parseSkillCommand } from "./sources/command";
import type { InspectResult, SourceRequest } from "./sources/types";

/*
 * One entry point for "where did this skill come from". The Add skill form
 * takes a pasted string and a user should not have to tell us which adapter
 * applies, so the order is fixed: an install command, then a GitHub URL, then
 * anything left is a folder on this machine.
 *
 * Parsing is pure. Nothing here reads a file or opens a connection; the
 * adapters do that, and they are added in Task 3.
 */

const OWNER_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function invalid(message: string): { error: string } {
  return { error: message };
}

/*
 * Decode, then judge. Validating the raw segment lets `%2F..%2F..%2Fetc` and
 * `%2F%2Fevil.example.com` survive as text and resolve somewhere else later, so
 * every segment is percent-decoded first and the decoded value is the one
 * checked. A decoded `.` or empty segment is normalised away; anything that
 * still carries a separator, a NUL, or a traversal is refused.
 */
function cleanPath(segments: string[]): string | { error: string } {
  const decoded: string[] = [];

  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return invalid(`"${segments.join("/")}" is not a readable folder path.`);
    }
    if (value === "" || value === ".") continue;
    if (
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0") ||
      /^[A-Za-z]:/.test(value)
    ) {
      return invalid(
        `"${value}" is not a folder name inside the repository. Remove any "..", absolute path, or backslash.`,
      );
    }
    decoded.push(value);
  }

  return decoded.join("/");
}

/*
 * A ref is decoded and then checked for the same separators as a path. GitHub
 * permits slashes in branch names, but the URL form cannot tell `feature/x`
 * from a ref and a path, so v1 refuses the ambiguous case rather than guessing.
 */
function cleanRef(ref: string): string | { error: string } {
  let value: string;
  try {
    value = decodeURIComponent(ref);
  } catch {
    return invalid(`"${ref}" is not a readable branch name.`);
  }
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("-")
  ) {
    return invalid(`"${value || ref}" is not a usable branch or commit name.`);
  }
  return value;
}

/** `github.com/{owner}/{repo}[/tree/{ref}/{path}|/blob/{ref}/{path}/SKILL.md]` */
function parseGithubUrl(value: string): SourceRequest | { error: string } | null {
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    // A bare filesystem path can parse as a URL with a one-letter host, so
    // only an explicit scheme makes this a URL we should reject.
    if (!value.includes("://")) return null;
    return invalid(
      `Only github.com is supported. Paste a github.com link, or a folder path on this machine.`,
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return invalid(`That link is missing a repository. Use github.com/owner/repo.`);
  }

  const [owner, rawRepo, mode, ...rest] = segments;
  const repo = rawRepo.replace(/\.git$/, "");
  if (
    !OWNER_SEGMENT.test(owner) ||
    !OWNER_SEGMENT.test(repo) ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    return invalid(`"${owner}/${rawRepo}" is not a valid owner and repository.`);
  }

  if (mode === undefined) {
    return { kind: "github", owner, repo };
  }
  if (mode !== "tree" && mode !== "blob") {
    return invalid(
      `"${mode}" is not a supported GitHub link. Use a repository, tree, or SKILL.md link.`,
    );
  }

  const [rawRef, ...pathParts] = rest;
  if (!rawRef) {
    return invalid(`That link is missing the branch or commit after "${mode}".`);
  }

  let pathParts2 = pathParts;
  if (mode === "blob") {
    const last = pathParts2[pathParts2.length - 1];
    if (last !== "SKILL.md") {
      return invalid(`A file link must end in SKILL.md; this one ends in "${last ?? ""}".`);
    }
    pathParts2 = pathParts2.slice(0, -1);
  }

  const path = cleanPath(pathParts2);
  if (typeof path !== "string") return path;

  const ref = cleanRef(rawRef);
  if (typeof ref !== "string") return ref;

  return path
    ? { kind: "github", owner, repo, ref, path }
    : { kind: "github", owner, repo, ref };
}

export function parseSource(input: string): SourceRequest | { error: string } {
  const value = input.trim();
  if (!value) {
    return invalid("Paste an install command, a github.com link, or a folder path.");
  }

  // Command-shaped input keeps the parser's specific rejection: a mistyped
  // `npx` line is not a folder that happens to be named `npx skills add ...`.
  if (value.split(/\s+/)[0] === "npx") {
    return parseSkillCommand(value);
  }

  const github = parseGithubUrl(value);
  if (github !== null) return github;

  if (value.startsWith("-")) {
    return invalid(`"${value}" is not a source. Paste an install command, a link, or a folder path.`);
  }
  return { kind: "local", root: value };
}

/*
 * Task 3 fills each branch with its adapter (sources/github.ts,
 * sources/local.ts). Until then the failure is loud on purpose: a quiet empty
 * result would look like a repository with no skills.
 */
export async function inspectSource(request: SourceRequest): Promise<InspectResult> {
  switch (request.kind) {
    case "github":
      throw new Error("adapter not implemented");
    case "local":
      throw new Error("adapter not implemented");
  }
}
