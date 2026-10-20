import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/*
 * ASH-121 AC05 sweep, pinned: every exported server action must reach a role
 * guard. A mutating action that only resolves membership lets a workspace
 * viewer write, so this scans each "use server" file and fails on any
 * exported action whose body calls neither authorize() nor requireRole().
 * Reads that any member (including viewers) may make are allowlisted by name
 * with the reason; adding a write to the allowlist fails review, not CI
 * semantics - keep the list honest.
 */

const ROOT = path.resolve(__dirname, "../..");

const VIEWER_READS: Record<string, string> = {
  searchWorkspace: "read-only search; membership alone authorizes viewing",
  getNoteAIRunOutputAction: "read-only poll of a run's output",
  loadWeeklyReviewAction: "read-only weekly summary of the caller's own tasks and focus sessions",
  loadPreferencesAction: "read-only load of the caller's own preference row; membership alone authorizes viewing",
};

function actionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...actionFiles(full));
    else if (entry.name.endsWith(".ts") && fs.readFileSync(full, "utf8").startsWith('"use server"')) {
      out.push(full);
    }
  }
  return out;
}

const files = [...actionFiles(path.join(ROOT, "src/app")), ...actionFiles(path.join(ROOT, "src/components"))];

describe("server action authorization sweep", () => {
  it("finds the action files", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  it("every exported action reaches a role guard or is an allowlisted read", () => {
    const unguarded: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const starts = [...source.matchAll(/^export async function (\w+)/gm)];
      for (let i = 0; i < starts.length; i++) {
        const name = starts[i][1];
        const body = source.slice(starts[i].index, starts[i + 1]?.index ?? source.length);
        if (VIEWER_READS[name]) continue;
        if (!/authorize\(\)|requireRole\(/.test(body)) {
          unguarded.push(`${path.relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("the viewer-read allowlist names only actions that still exist", () => {
    const all = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const name of Object.keys(VIEWER_READS)) {
      expect(all).toContain(`export async function ${name}(`);
    }
  });
});
