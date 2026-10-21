import type { SourceRequest } from "./types";

/*
 * The paste target for the Add skill form. People paste the command they were
 * told to run in a README, and that command must never reach a shell: this
 * parser decides whether the string is the one supported form and returns
 * coordinates. It never shells out, so a rejection is the whole safety story.
 *
 * Rejections name the token and the form to paste instead. "Invalid command"
 * teaches nobody what to change.
 */

const SHELL_OPERATORS: Array<{ token: string; reason: string }> = [
  { token: "&&", reason: "runs a second command when the first succeeds" },
  { token: "||", reason: "runs a second command when the first fails" },
  { token: "$(", reason: "substitutes the output of another command" },
  { token: ";", reason: "runs another command" },
  { token: "|", reason: "pipes output into another program" },
  { token: ">", reason: "redirects output to a file" },
  { token: "<", reason: "reads input from a file" },
  { token: "`", reason: "substitutes the output of another command" },
  { token: "&", reason: "runs the command in the background" },
  { token: "\n", reason: "starts a second command" },
];

const SAFE_FORM = 'npx skills add owner/repo';

/**
 * GitHub allows letters, digits, dots, hyphens and underscores in both halves.
 * Dots alone are not a name: `x/..` and `x/.` are traversal, not a repository.
 */
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function rejection(message: string): { error: string } {
  return { error: message };
}

function isTraversal(segment: string): boolean {
  return segment === "." || segment === "..";
}

/*
 * The value is decoded before it is judged: `%2e%2e` is `..` to any later
 * consumer, and a backslash is a separator on Windows even when the archive
 * came from GitHub. Empty and `.` segments are dropped so `p//x`, `p/./x` and
 * `p/x` name the same folder.
 */
function cleanRelativePath(value: string): { path: string } | { error: string } {
  if (value.startsWith("/") || value.includes("\\")) {
    return { error: "must be relative to the repository and cannot start with a slash or contain a backslash" };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { error: "is not a readable folder path" };
  }

  const segments = decoded.split("/");
  if (segments.includes("..") || segments.some((segment) => segment.includes("\0"))) {
    return { error: 'must stay inside the repository and cannot contain ".."' };
  }
  const path = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return path ? { path } : { error: "is not a folder name" };
}

export function parseSkillCommand(input: string): SourceRequest | { error: string } {
  const command = input.trim();
  if (!command) {
    return rejection(`Paste a command in the form "${SAFE_FORM}".`);
  }

  for (const { token, reason } of SHELL_OPERATORS) {
    if (command.includes(token)) {
      return rejection(
        `This command contains "${token}", which ${reason}. Remove everything except "${SAFE_FORM}".`,
      );
    }
  }

  const tokens = command.split(/\s+/);
  if (tokens[0] !== "npx") {
    return rejection(
      `Only npx is allowed, but this command starts with "${tokens[0]}". Use "${SAFE_FORM}".`,
    );
  }

  // A truncated command has no token to name; quoting an empty string would
  // read as a bug in the message rather than in the paste.
  const named = (value: string | undefined, fallback: string) =>
    value === undefined ? fallback : `"${value}"`;

  if (tokens[1] !== "skills") {
    return rejection(
      `Only the "skills" package is supported after npx, not ${named(tokens[1], "nothing")}. Use "${SAFE_FORM}".`,
    );
  }
  if (tokens[2] !== "add") {
    return rejection(
      `Only "add" is supported after "npx skills", not ${named(tokens[2], "nothing")}. Use "${SAFE_FORM}".`,
    );
  }

  let repository: string | undefined;
  let path: string | undefined;

  // `--path` is accepted before or after the repository: people paste both
  // orders, and the tokens are independent, so there is nothing to gain from
  // rejecting one of them.
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "--path") {
      if (path !== undefined) {
        return rejection('Give "--path" only once.');
      }
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return rejection('Give "--path" a folder inside the repository, for example "--path skills".');
      }
      const cleaned = cleanRelativePath(value);
      if ("error" in cleaned) {
        return rejection(`The "--path" value "${value}" ${cleaned.error}.`);
      }
      path = cleaned.path;
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return rejection(
        `The flag "${token}" is not supported. Use "--path" to pick a folder, as in "${SAFE_FORM} --path skills".`,
      );
    }

    if (repository !== undefined) {
      return rejection(
        `Unexpected argument "${token}". Use "${SAFE_FORM}" with one owner/repo and an optional "--path folder".`,
      );
    }
    repository = token;
  }

  if (repository === undefined) {
    return rejection(`Name the repository to add, for example "${SAFE_FORM}".`);
  }

  const segments = repository.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => !REPO_SEGMENT.test(segment) || isTraversal(segment))
  ) {
    return rejection(
      `"${repository}" is not an owner/repo pair. Use "${SAFE_FORM}" — a URL, an SSH address, or a path will not work.`,
    );
  }

  return { kind: "github", owner: segments[0], repo: segments[1], path };
}
