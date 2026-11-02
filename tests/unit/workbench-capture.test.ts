import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCapturePlan,
  CAPTURE_DISCLOSURE,
  CaptureError,
  collectGitState,
  parseTestResults,
  RATIONALE_INFERRED,
} from "../../scripts/workbench/capture-core";

/*
 * The spec's verification row: capture catches shell-made changes, not just
 * editor events. The fixture repository is mutated with sed (a shell, the
 * thing hooks never see) and capture must record the resulting diff; an
 * empty or mismatched diff is the failure the test exists to catch.
 */

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function makeFixtureRepo(): { repoPath: string; baseSha: string; filePath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), "wb-capture-"));
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.email", "fixture@example.com");
  git(repoPath, "config", "user.name", "Fixture");
  const filePath = join(repoPath, "app.ts");
  writeFileSync(filePath, "export const value = 'before';\n");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  return { repoPath, baseSha: git(repoPath, "rev-parse", "HEAD").trim(), filePath };
}

/** The shell-made change: sed, then a commit, so the capture point is clean. */
function sedChange(repoPath: string, filePath: string): void {
  execFileSync("sed", ["-i", "s/before/after/", filePath]);
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "shell-made change");
}

describe("workbench capture-core", () => {
  it("catches a sed-made change between base and HEAD", async () => {
    const fixture = makeFixtureRepo();
    sedChange(fixture.repoPath, fixture.filePath);

    const state = await collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha });

    expect(state.diffBytes.byteLength).toBeGreaterThan(0);
    expect(state.headSha).not.toBe(fixture.baseSha);
    expect(state.changedPaths.some((line) => line.includes("app.ts"))).toBe(true);
    expect(state.commitSubjects).toEqual([{ sha: state.headSha, subject: "shell-made change" }]);
    // No origin remote in the fixture: the repo path stands in, so repoUrl is never empty.
    expect(state.repoUrl).toBe(`file://${fixture.repoPath}`);
  });

  it("fails on an empty diff — capturing a no-op would manufacture evidence", async () => {
    const fixture = makeFixtureRepo();
    await expect(collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha })).rejects.toMatchObject({
      code: "empty_diff",
    });
  });

  it("fails on a dirty tree — base..HEAD is only complete when nothing is uncommitted", async () => {
    const fixture = makeFixtureRepo();
    execFileSync("sed", ["-i", "s/before/after/", fixture.filePath]);
    await expect(collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha })).rejects.toMatchObject({
      code: "dirty_tree",
    });
  });

  it("fails on a base that does not resolve", async () => {
    const fixture = makeFixtureRepo();
    sedChange(fixture.repoPath, fixture.filePath);
    await expect(collectGitState({ repoPath: fixture.repoPath, baseSha: "deadbeef" })).rejects.toMatchObject({
      code: "bad_base",
    });
  });

  it("fails on a diff over the blob size bound instead of truncating it", async () => {
    const fixture = makeFixtureRepo();
    writeFileSync(join(fixture.repoPath, "big.txt"), `${"x".repeat(5 * 1024 * 1024)}\n`);
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "oversized");
    await expect(collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha })).rejects.toMatchObject({
      code: "diff_too_large",
    });
  });

  it("preserves non-UTF-8 diff bytes exactly and resolves the base ref to a commit", async () => {
    const fixture = makeFixtureRepo();
    // Latin-1 bytes are not valid UTF-8: a utf8 round-trip would corrupt them.
    writeFileSync(join(fixture.repoPath, "latin.txt"), Buffer.from("caf\u00e9\n", "latin1"));
    git(fixture.repoPath, "add", ".");
    git(fixture.repoPath, "commit", "-m", "non-utf8 content");

    const state = await collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha.slice(0, 10) });
    // A ref expression (short sha, branch name) is not a stable endpoint: the
    // record must carry the full resolved commit SHA.
    expect(state.baseSha).toBe(fixture.baseSha);

    const raw = execFileSync("git", ["-C", fixture.repoPath, "diff", "--binary", "--no-textconv", "--no-ext-diff", fixture.baseSha, "HEAD"], { encoding: "buffer" });
    expect(raw.includes(0xe9)).toBe(true);
    expect(Buffer.from(state.diffBytes).equals(raw)).toBe(true);
  });

  it("ignores an external diff driver — git must generate the patch itself", async () => {
    const fixture = makeFixtureRepo();
    sedChange(fixture.repoPath, fixture.filePath);
    git(fixture.repoPath, "config", "diff.external", "echo EXTERNAL-DIFF-RAN");

    const state = await collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha });

    const text = Buffer.from(state.diffBytes).toString("utf8");
    expect(text.startsWith("diff --git")).toBe(true);
    expect(text).not.toContain("EXTERNAL-DIFF-RAN");
  });

  it("parses the provided test-results file in both shapes and stamps missing runAt", () => {
    const capturedAt = "2026-11-02T00:00:00.000Z";
    const bare = parseTestResults(JSON.stringify([{ name: "auth login", ok: true }]), capturedAt);
    expect(bare).toEqual([{ name: "auth login", ok: true, runAt: capturedAt }]);

    const wrapped = parseTestResults(
      JSON.stringify({ results: [{ name: "auth logout", ok: false, runAt: "2026-11-01T10:00:00.000Z" }] }),
      capturedAt,
    );
    expect(wrapped).toEqual([{ name: "auth logout", ok: false, runAt: "2026-11-01T10:00:00.000Z" }]);

    expect(() => parseTestResults("not json", capturedAt)).toThrow(CaptureError);
    expect(() => parseTestResults(JSON.stringify([{ name: "", ok: "yes" }]), capturedAt)).toThrow(CaptureError);
  });

  it("builds a deterministic brief with the disclosure line and the inferred-rationale fallback", async () => {
    const fixture = makeFixtureRepo();
    sedChange(fixture.repoPath, fixture.filePath);
    const state = await collectGitState({ repoPath: fixture.repoPath, baseSha: fixture.baseSha });

    const inferred = await buildCapturePlan({
      state,
      workspaceId: "ws",
      runId: null,
      testResults: [],
      decisionNote: null,
      decisionStatus: "inferred",
    });
    expect(inferred.briefMarkdown).toContain(CAPTURE_DISCLOSURE);
    expect(inferred.briefMarkdown).toContain(RATIONALE_INFERRED);
    expect(inferred.briefMarkdown).toContain("app.ts");
    expect(inferred.briefMarkdown).toContain("none provided");
    expect(inferred.decisionStatus).toBe("inferred");
    expect(inferred.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inferred.diffBytes).toBe(state.diffBytes);

    const recorded = await buildCapturePlan({
      state,
      workspaceId: "ws",
      runId: "run-1",
      testResults: [{ name: "auth login", ok: true, runAt: "2026-11-02T00:00:00.000Z" }],
      decisionNote: "split the checkout so the dialog owns its own state",
      decisionStatus: "recorded",
    });
    expect(recorded.briefMarkdown).toContain("1 passed, 0 failed (from the provided file)");
    expect(recorded.briefMarkdown).toContain("split the checkout so the dialog owns its own state");
    expect(recorded.decisionStatus).toBe("recorded");
    // The same bytes hash identically — the property blob dedupe relies on.
    expect(recorded.diffHash).toBe(inferred.diffHash);
  });
});
