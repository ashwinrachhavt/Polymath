import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STUBBED_TOOLS } from "../../eve/alfred/evals/stubs";

/*
 * Every authored tool must have a stub, because eve's stub layer runs the real
 * tool when nothing matches:
 *
 *   tool-stubs/execute.js: `executeWithToolStub` -> `i === void 0 ? r() : ...`
 *   tool-stubs/playback.js: an unmatched tool records `{ kind: "real" }`
 *
 * So adding a file under `agent/tools/` silently gives every eval live access to
 * it. That is how an eval stubbing only `documents_search` reached
 * `connected_read` and read the owner's inbox (chat-grounding.eval.ts records
 * the incident). A convention cannot stop the next tool file; this check can.
 *
 * The registered name is derived the way eve's compiler derives it
 * (`compiler/normalize-tool.js`): the logical path relative to `tools/`, without
 * its extension, with `/` replaced by `-`. A flat `documents_search.ts` is
 * `documents_search`; `tools/wiki/read.ts` would be `wiki-read`.
 */

const TOOLS_DIR = fileURLToPath(new URL("../../eve/alfred/agent/tools", import.meta.url));
const TOOL_SUFFIX = ".ts";

function toolFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...toolFiles(path));
    // A `.d.ts` is a declaration, not a tool module; eve only compiles modules.
    else if (entry.isFile() && entry.name.endsWith(TOOL_SUFFIX)) found.push(path);
  }
  return found;
}

export function registeredToolName(path: string): string {
  return relative(TOOLS_DIR, path)
    .slice(0, -TOOL_SUFFIX.length)
    .split(sep)
    .join("-");
}

function unlistedTools(
  tools: ReadonlySet<string>,
  stubbed: Readonly<Record<string, unknown>>,
): string[] {
  return [...tools].filter((tool) => !Object.hasOwn(stubbed, tool)).sort();
}

describe("eval stub coverage", () => {
  it("derives the registered name the way eve's compiler does", () => {
    expect(registeredToolName(join(TOOLS_DIR, "documents_search.ts"))).toBe("documents_search");
    // The real inbox read this guard exists for.
    expect(registeredToolName(join(TOOLS_DIR, "connected_read.ts"))).toBe("connected_read");
    expect(registeredToolName(join(TOOLS_DIR, "wiki", "read.ts"))).toBe("wiki-read");
  });

  it("every tool file has a stub, so no eval can call one for real", () => {
    const tools = new Set(toolFiles(TOOLS_DIR).map(registeredToolName));
    // A directory that stopped resolving would make the assertion below vacuous.
    expect(tools.size).toBeGreaterThan(0);
    expect(unlistedTools(tools, STUBBED_TOOLS)).toEqual([]);
  });

  it("names an unlisted tool, so the failure says which file to add", () => {
    // Proves the check bites: the same comparison that runs above, with the
    // probe a new tool file would produce.
    const withProbe = new Set(["documents_search", "__coverage_probe"]);
    expect(unlistedTools(withProbe, { documents_search: {} })).toEqual(["__coverage_probe"]);
  });
});
