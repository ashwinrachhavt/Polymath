/*
 * The mechanical half of checkpoint capture: git state in, a capture plan
 * out. No database, no model, no network — everything here is child-process
 * git over the repository the caller points at, so the unit tests can drive
 * it against a fixture repository the way the spec's verification table
 * demands (a sed-made change must be caught). The write half lives in
 * capture.ts.
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import type { CapturedTestResult } from "@/domains/agents/schema";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";

export class CaptureError extends Error {
  constructor(
    readonly code:
      | "bad_base"
      | "dirty_tree"
      | "empty_diff"
      | "diff_too_large"
      | "invalid_test_results",
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export type CommitSubject = { sha: string; subject: string };

export type GitCaptureState = {
  repoPath: string;
  repoUrl: string;
  baseSha: string;
  headSha: string;
  diffBytes: Uint8Array;
  changedPaths: string[];
  commitSubjects: CommitSubject[];
};

export type CapturePlan = {
  repoUrl: string;
  baseSha: string;
  headSha: string;
  /** The diff the plan would store; carried so the writer never re-reads git. */
  diffBytes: Uint8Array;
  diffHash: string;
  diffByteLength: number;
  changedPaths: string[];
  commitSubjects: CommitSubject[];
  workspaceId: string;
  runId: string | null;
  testResults: CapturedTestResult[];
  decisionNote: string | null;
  decisionStatus: "recorded" | "inferred";
  artifactTitle: string;
  /** The deterministic brief the capture produces; the model is never in this path. */
  briefMarkdown: string;
  linkContext: string;
};

function runGit(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
      else resolvePromise(stdout);
    });
  });
}

// The diff is binary data, not text: a utf8 decode would silently corrupt the
// stored patch and its hash for any file whose bytes are not valid UTF-8.
function runGitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", repoPath, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed: ${stderr.toString().trim() || error.message}`));
      else resolvePromise(stdout);
    });
  });
}

const MAX_BRIEF_COMMITS = 50;
const MAX_BRIEF_PATHS = 200;

/**
 * Verify the capture point and read it: base and HEAD must resolve, the tree
 * must be clean (a checkpoint of base..HEAD is only complete when nothing is
 * uncommitted), and the diff must be non-empty (capturing a no-op would
 * manufacture evidence that something changed).
 */
export async function collectGitState(input: { repoPath: string; baseSha: string }): Promise<GitCaptureState> {
  const repoPath = resolve(input.repoPath);
  let baseSha: string;
  try {
    baseSha = (await runGit(repoPath, ["rev-parse", "--verify", `${input.baseSha}^{commit}`])).trim();
  } catch {
    throw new CaptureError("bad_base", `Base ${input.baseSha} does not resolve to a commit in ${repoPath}`);
  }
  const headSha = (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();
  const status = await runGit(repoPath, ["status", "--porcelain"]);
  if (status.trim() !== "") {
    throw new CaptureError("dirty_tree", `Working tree at ${repoPath} is not clean; commit or stash before capture`);
  }
  // --no-textconv and --no-ext-diff: a converted or external rendering must
  // never stand in for the actual bytes, and identical conversions or empty
  // external output could read as an empty diff.
  const diffBytes: Uint8Array = await runGitBuffer(repoPath, ["diff", "--binary", "--no-textconv", "--no-ext-diff", baseSha, headSha]);
  if (diffBytes.length === 0) {
    throw new CaptureError("empty_diff", `No diff between ${baseSha} and ${headSha}; nothing to capture`);
  }
  if (diffBytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new CaptureError("diff_too_large", `Diff is ${diffBytes.byteLength} bytes, over the ${MAX_UPLOAD_BYTES}-byte blob limit`);
  }
  const changedPaths = (await runGit(repoPath, ["diff", "--name-status", baseSha, headSha]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const commitSubjects = (await runGit(repoPath, ["log", "--format=%H%x09%s", `${baseSha}..${headSha}`]))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [sha, subject] = line.split("\t");
      return { sha, subject: subject ?? "" };
    });
  const remote = (await runGit(repoPath, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  return { repoPath, repoUrl: remote || `file://${repoPath}`, baseSha, headSha, diffBytes, changedPaths, commitSubjects };
}

const testResultEntry = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  runAt: z.string().min(1).optional(),
});
const testResultsPayload = z.union([z.array(testResultEntry), z.object({ results: z.array(testResultEntry) })]);

/**
 * Parse the provided test-results file: a bare array or { results: [...] } of
 * { name, ok, runAt? }. Entries missing runAt stamp the capture time — the
 * file is the operator's word about a run they already did.
 */
export function parseTestResults(raw: string, capturedAt: string): CapturedTestResult[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new CaptureError("invalid_test_results", "Test-results file is not JSON");
  }
  const parsed = testResultsPayload.safeParse(parsedJson);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new CaptureError("invalid_test_results", `Test-results file does not match { name, ok, runAt?[] }: ${detail}`);
  }
  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.results;
  return entries.map((entry) => ({ name: entry.name, ok: entry.ok, runAt: entry.runAt ?? capturedAt }));
}

/** The disclosure line every brief carries: capture is local and model-free. */
export const CAPTURE_DISCLOSURE = "Captured locally from git state and provided test results. Nothing was sent to a model.";
/** The literal fallback when no decision was recorded at capture time. */
export const RATIONALE_INFERRED = "rationale inferred after implementation";

function formatCommitLines(subjects: CommitSubject[]): string[] {
  const lines = subjects.slice(0, MAX_BRIEF_COMMITS).map((c) => `  - ${c.sha.slice(0, 12)} ${c.subject}`);
  if (subjects.length > MAX_BRIEF_COMMITS) lines.push(`  - … and ${subjects.length - MAX_BRIEF_COMMITS} more`);
  return lines;
}

function formatPathLines(paths: string[]): string[] {
  const lines = paths.slice(0, MAX_BRIEF_PATHS).map((p) => `  - ${p}`);
  if (paths.length > MAX_BRIEF_PATHS) lines.push(`  - … and ${paths.length - MAX_BRIEF_PATHS} more`);
  return lines;
}

export function buildCapturePlan(input: {
  state: GitCaptureState;
  workspaceId: string;
  runId: string | null;
  testResults: CapturedTestResult[];
  decisionNote: string | null;
  decisionStatus: "recorded" | "inferred";
}): Promise<CapturePlan> {
  const { state } = input;
  const decisionLine = input.decisionNote ?? RATIONALE_INFERRED;
  const passed = input.testResults.filter((r) => r.ok).length;
  const failed = input.testResults.length - passed;
  const testLine =
    input.testResults.length === 0
      ? "  - none provided"
      : `  - ${passed} passed, ${failed} failed (from the provided file)`;
  const briefMarkdown = [
    `# Change checkpoint: ${state.headSha.slice(0, 12)}`,
    "",
    `*${CAPTURE_DISCLOSURE}*`,
    "",
    `- Repository: ${state.repoUrl}`,
    `- Commits: ${state.baseSha.slice(0, 12)}..${state.headSha.slice(0, 12)} (${state.commitSubjects.length} commit(s))`,
    ...formatCommitLines(state.commitSubjects),
    `- Changed paths (${state.changedPaths.length}):`,
    ...formatPathLines(state.changedPaths),
    "- Test results:",
    testLine,
    `- Decision (${input.decisionStatus}): ${decisionLine}`,
    "",
  ].join("\n");
  return sha256Hex(state.diffBytes).then(
    (diffHash): CapturePlan => ({
      repoUrl: state.repoUrl,
      baseSha: state.baseSha,
      headSha: state.headSha,
      diffBytes: state.diffBytes,
      diffHash,
      diffByteLength: state.diffBytes.byteLength,
      changedPaths: state.changedPaths,
      commitSubjects: state.commitSubjects,
      workspaceId: input.workspaceId,
      runId: input.runId,
      testResults: input.testResults,
      decisionNote: input.decisionNote,
      decisionStatus: input.decisionStatus,
      artifactTitle: `Change checkpoint ${state.headSha.slice(0, 12)}`,
      briefMarkdown,
      linkContext: input.decisionNote ?? `Mechanical capture of ${state.baseSha.slice(0, 12)}..${state.headSha.slice(0, 12)} git state`,
    }),
  );
}
