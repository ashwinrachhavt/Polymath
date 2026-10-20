import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/*
 * The CI eval table. It is the only view a reviewer gets without downloading the
 * eval artifact, so a wrong verdict here is worse than no table: a failing eval
 * rendered as passing would tell a reviewer the gate held when it did not.
 *
 * The script is run as a subprocess because that is how CI invokes it, and
 * because its contract is its stdout plus the step-summary append.
 */

const SCRIPT = join(import.meta.dirname, "../../.github/scripts/eval-summary.mjs");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-summary-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(report: unknown, opts: { polluted?: boolean } = {}) {
  const file = join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
  const body = JSON.stringify(report, null, 2);
  // eve prints warnings on stdout before the report document; the script must
  // find the object rather than trusting the whole buffer.
  writeFileSync(file, opts.polluted ? `[eve:warning] something\n${body}\n` : body);
  return spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
}

function report(results: Array<{ id: string; assertions: Array<{ name: string; passed: boolean }>; status?: string }>) {
  return {
    target: { url: "http://127.0.0.1:1" },
    results: results.map((r) => ({
      id: r.id,
      assertions: r.assertions,
      verdict: { status: r.status ?? "passed" },
    })),
  };
}

describe("eval-summary", () => {
  it("renders a pass row per eval with its gate count", () => {
    const out = run(
      report([
        { id: "a", assertions: [{ name: "g1", passed: true }, { name: "g2", passed: true }] },
        { id: "b", assertions: [{ name: "g1", passed: true }] },
      ]),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("2/2 passed");
    expect(out.stdout).toContain("| `a` | pass | 2/2 |");
    expect(out.stdout).toContain("| `b` | pass | 1/1 |");
  });

  it("marks a failing eval and names its first failing assertion", () => {
    // The failure has to be visible in the table; a reviewer should not need
    // the artifact to know which gate broke.
    const out = run(
      report([
        {
          id: "chat-grounding/0000",
          assertions: [
            { name: "calledTool(documents_search)", passed: true },
            { name: "messageIncludes(lease)", passed: false },
          ],
          status: "failed",
        },
      ]),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("0/1 passed");
    expect(out.stdout).toContain("**fail**");
    expect(out.stdout).toContain("1/2");
    expect(out.stdout).toContain("messageIncludes(lease)");
  });

  it("finds the report after framework noise on stdout", () => {
    const out = run(report([{ id: "a", assertions: [{ name: "g", passed: true }] }]), { polluted: true });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("1/1 passed");
  });

  it("marks a crashed eval as failed even though it has no assertions", () => {
    // The bug this guards: a crashed/timed-out eval reports verdict "failed"
    // with zero assertions, and a check that only counted failed assertions
    // rendered it as "✅ 1/1 passed" — a false green on the gate itself.
    const out = run({
      target: { url: "u" },
      results: [{ id: "crashed", assertions: [], verdict: "failed", error: "model timeout" }],
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("0/1 passed");
    expect(out.stdout).toContain("**fail**");
    expect(out.stdout).toContain("model timeout");
  });

  it("reads a plain-string verdict, not the session status", () => {
    // The runner writes `verdict: "passed"`. Reading `verdict.status` yields
    // undefined and falls through to the session's own state ("waiting" for a
    // healthy open session), which made every real report render as failed.
    const out = run({
      target: { url: "u" },
      results: [
        { id: "ok", assertions: [{ name: "g", passed: true }], verdict: "passed", result: { status: "waiting" } },
        { id: "bad", assertions: [{ name: "g", passed: true }], verdict: "failed", result: { status: "waiting" } },
      ],
    });
    expect(out.stdout).toContain("1/2 passed");
    expect(out.stdout).toContain("| `ok` | pass | 1/1 |");
    expect(out.stdout).toContain("| `bad` | **fail** | 1/1 |");
  });

  it("treats an unrecognised verdict as a failure, not a pass", () => {
    const out = run({
      target: { url: "u" },
      results: [{ id: "weird", assertions: [{ name: "g", passed: true }], verdict: "something-new" }],
    });
    expect(out.stdout).toContain("0/1 passed");
    expect(out.stdout).toContain("**fail**");
  });

  it("fails loudly when there is no report to render", () => {
    // A missing report means the gate did not run. Printing an empty table
    // would render that as success.
    const file = join(dir, "empty.json");
    writeFileSync(file, "not json at all");
    const out = spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("did not produce a parseable result");
  });

  it("appends to the GitHub step summary when the env var is set", () => {
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const file = join(dir, "report-step.json");
    writeFileSync(file, JSON.stringify(report([{ id: "a", assertions: [{ name: "g", passed: true }] }]), null, 2));
    const out = spawnSync("node", [SCRIPT, file], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(out.status).toBe(0);
    const written = readFileSync(summary, "utf8");
    expect(written).toContain("Agent evals: 1/1 passed");
  });
});
