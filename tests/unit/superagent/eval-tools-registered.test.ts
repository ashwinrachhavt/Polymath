import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_TOOLS } from "@/domains/superagent/assessor/eve";

/*
 * Every tool an eval session is pinned to must exist as an authored eve tool.
 *
 * The assessor pins EVAL_TOOLS twice from one constant (the profile's ceiling
 * in ensureAssessorProfile and every run's snapshot in EveForAssessor.start),
 * and eve derives a tool's registered name from its file path the way its
 * compiler does (`compiler/normalize-tool.js`): the path relative to
 * `agent/tools/`, without the extension, with `/` joined by `-` — so a pinned
 * name resolves iff a module of that name exists in the flavor's tools
 * directory. When a pin names a module that does not exist, nothing fails at
 * pin time: the session starts, the judge cannot call any tool, and it
 * finishes in prose — the admission never reaches a decision and the person's
 * message dies with "This run has no agent session." That was the cutover
 * failure (the pin shipped before the tools did); this check holds the line.
 *
 * Static like the stub-coverage guard (`tests/unit/eval-stub-coverage.test.ts`)
 * because the convention, not an import, is the contract: eve compiles the
 * file to the tool, so the file's existence under the derived name is what a
 * pin depends on. Whether the tool behaves is the assessor specs' claim
 * (tests/unit/superagent/assessor.test.ts); this claims only that the names
 * resolve.
 */

const TOOLS_DIR = fileURLToPath(new URL("../../../eve/specialist/agent/tools", import.meta.url));
const TOOL_SUFFIX = ".ts";

/** Registered names for every tool module in the specialist flavor's tools directory. */
function registeredToolNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) names.push(...registeredToolNames(path));
    // A `.d.ts` is a declaration, not a tool module; eve only compiles modules.
    else if (entry.isFile() && entry.name.endsWith(TOOL_SUFFIX))
      names.push(relative(dir, path).slice(0, -TOOL_SUFFIX.length).split(sep).join("-"));
  }
  return names.sort();
}

describe("eval tool pins", () => {
  it("resolves every pinned eval tool to a registered eve tool", () => {
    // A vacuous pin list would pass trivially; the assessor's whole protocol
    // rides these three, so an empty EVAL_TOOLS is itself the regression.
    expect(EVAL_TOOLS.length, "EVAL_TOOLS pins no tools — the judge protocol has nothing to run").toBeGreaterThan(0);

    const registered = new Set(registeredToolNames(TOOLS_DIR));
    const missing = [...EVAL_TOOLS].filter((tool) => !registered.has(tool)).sort();

    expect(
      missing,
      [
        "EVAL_TOOLS pins tool names with no module under eve/specialist/agent/tools/ —",
        "an eval session pinned to them starts, cannot call its tools, and the",
        "judge finishes in prose: the admission never reaches a decision. Author",
        "each missing tool at eve/specialist/agent/tools/<name>.ts (the registered",
        "name is the path relative to agent/tools/, `/` joined by `-`), or narrow",
        "the pin to tools that exist.",
      ].join(" "),
    ).toEqual([]);
  });
});
