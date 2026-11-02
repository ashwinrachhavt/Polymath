import { describe, expect, it } from "vitest";

import { cwdMatchesProjectRoot } from "@/lib/agent-artifacts/cwd-match";

/*
 * The cwd-to-project match (Workbench D3). The slug directory is never
 * decoded; the transcript cwd is compared against the project's local repo
 * path — equal, or nested under it, never a bare prefix (a repo must not
 * claim sessions from a sibling directory that shares its name prefix).
 *
 * value: protects=which sessions a project page shows (the attachment between
 * an imported session and a project);
 * fails_when=a sibling directory's sessions appear, a trailing slash breaks
 * the match, or a subdirectory session is missed;
 * seam=cwdMatchesProjectRoot in isolation, no database, no filesystem.
 */
describe("cwdMatchesProjectRoot", () => {
  it("matches the repo path itself", () => {
    expect(cwdMatchesProjectRoot("/home/me/work/repo", "/home/me/work/repo")).toBe(true);
  });

  it("matches a session run from a subdirectory of the repo", () => {
    expect(cwdMatchesProjectRoot("/home/me/work/repo/packages/app", "/home/me/work/repo")).toBe(true);
  });

  it("ignores trailing slashes on either side", () => {
    expect(cwdMatchesProjectRoot("/home/me/work/repo/", "/home/me/work/repo")).toBe(true);
    expect(cwdMatchesProjectRoot("/home/me/work/repo", "/home/me/work/repo/")).toBe(true);
    expect(cwdMatchesProjectRoot("/home/me/work/repo/", "/home/me/work/repo/")).toBe(true);
  });

  it("never claims a sibling whose name shares the prefix", () => {
    expect(cwdMatchesProjectRoot("/home/me/work/repo-evil", "/home/me/work/repo")).toBe(false);
    expect(cwdMatchesProjectRoot("/home/me/work/repository", "/home/me/work/repo")).toBe(false);
  });

  it("rejects unrelated paths", () => {
    expect(cwdMatchesProjectRoot("/home/other/repo", "/home/me/work/repo")).toBe(false);
    expect(cwdMatchesProjectRoot("/", "/home/me/work/repo")).toBe(false);
  });

  it("treats an empty side as no match", () => {
    expect(cwdMatchesProjectRoot("", "/home/me/work/repo")).toBe(false);
    expect(cwdMatchesProjectRoot("/home/me/work/repo", "")).toBe(false);
    expect(cwdMatchesProjectRoot("   ", "/home/me/work/repo")).toBe(false);
  });

  it("compares case-preserved — the user's own filesystem spelling", () => {
    // A local path is typed by the same person the agent worked for; silently
    // folding case would paper over a typo instead of showing no sessions.
    expect(cwdMatchesProjectRoot("/home/me/Work/Repo", "/home/me/work/repo")).toBe(false);
  });
});
