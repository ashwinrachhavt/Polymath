import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/*
 * Error boundaries are client components whose whole contract is copy plus two
 * controls, so the assertions are on source text rather than on rendered
 * output. What matters: no boundary claims what an earlier write did, each
 * keeps a working retry, and each shows the digest that ties a crash to the
 * server log.
 */

const ROOT = path.resolve(__dirname, "../..");

const GLOBAL = "src/app/global-error.tsx";
const WORKSPACE = "src/app/(workspace)/error.tsx";
const ALFRED = "src/app/(workspace)/apps/alfred/error.tsx";
const COMMAND_CENTER = "src/app/(workspace)/apps/command-center/error.tsx";

// Every boundary, whatever its route.
const BOUNDARIES = [GLOBAL, WORKSPACE, ALFRED, COMMAND_CENTER];
// The ones whose copy was rewritten by this task.
const APP_LEVEL = [GLOBAL, ALFRED, COMMAND_CENTER];

// Claims a render crash cannot make. Checked as a blocklist because a rewrite
// asserting an outcome in new words is exactly the regression to catch.
const OUTCOME_CLAIMS = [
  /was not saved/i,
  /nothing was sent/i,
  /no external action/i,
  /have performed any work/i,
];

function source(rel: string) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/*
 * The outcome-claim checks are about what a reader sees, so comments and JSX
 * comments are removed first: an internal note explaining the rule must not
 * count as breaking it.
 */
function copy(rel: string) {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("global error boundary", () => {
  const file = () => source(GLOBAL);

  it("is a client component that supplies its own document", () => {
    const text = file();
    expect(text).toContain('"use client"');
    expect(text).toMatch(/<html[\s>]/);
    expect(text).toMatch(/<body[\s>]/);
    expect(text).toContain("<title>Polymath could not start</title>");
  });

  it("styles itself without Tailwind classes or the app stylesheet", () => {
    const text = file();
    // No stylesheet is guaranteed to have loaded when this renders, so a
    // utility className would silently do nothing.
    expect(text).not.toContain("className");
    expect(text).toContain("style={{");
    expect(text).toContain("prefers-color-scheme: dark");
    expect(text).toContain("color-scheme");
  });

  it("offers a retry and a reload", () => {
    const text = file();
    expect(text).toContain("onClick={reset}");
    expect(text).toContain("onClick={() => window.location.reload()}");
    expect(text).toContain("Reload");
  });

  it("shows the digest when present", () => {
    expect(file()).toContain("error.digest");
  });
});

describe("app-level error boundaries", () => {
  it("drop the outcome guarantees a render crash cannot make", () => {
    expect(source(ALFRED)).not.toContain("have not performed any work");
    expect(source(COMMAND_CENTER)).not.toContain("Retry without creating a new external action");
  });

  it("assert no outcome at all, whatever the wording", () => {
    for (const rel of APP_LEVEL) {
      const text = copy(rel);
      for (const claim of OUTCOME_CLAIMS) {
        expect(text, `${rel} matches ${claim}`).not.toMatch(claim);
      }
    }
  });

  it("say the earlier result is unknown and tell the reader to check", () => {
    for (const rel of APP_LEVEL) {
      const text = copy(rel);
      expect(text, rel).toMatch(/may (still )?have/i);
      expect(text, rel).toMatch(/check/i);
    }
  });

  it("keep the alert role and a retry control", () => {
    for (const rel of APP_LEVEL) {
      const text = source(rel);
      if (rel === GLOBAL) continue; // checked above, uses a plain button
      expect(text, rel).toContain('role="alert"');
      expect(text, rel).toMatch(/onClick=\{reset\}/);
    }
  });
});

describe("boundary diagnostics", () => {
  it("every boundary surfaces the digest", () => {
    for (const rel of BOUNDARIES) {
      expect(source(rel), rel).toContain("error.digest");
    }
  });

  it("uses no em dash", () => {
    for (const rel of BOUNDARIES) {
      expect(source(rel), rel).not.toContain("—");
    }
  });
});
