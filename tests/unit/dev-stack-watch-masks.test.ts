import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * `next dev` in the web container watches the whole bind-mounted repo and
 * Next 16 has no watcher ignore option, so every write by a tool (an agent's
 * checkout, a Playwright run, a QA screenshot) recompiles and pushes a rebuild
 * to every open tab. The only ignore list is the set of anonymous volumes that
 * mask those folders in compose.yaml. This pins that list to the repo's own
 * ignored tool-output folders, so a new one cannot be added to .gitignore and
 * forgotten here.
 */

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const compose = readFileSync(join(root, "compose.yaml"), "utf8");
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");

/** Folders that tools write into the repo root while the stack runs. The app never reads them. */
const TOOL_OUTPUT_DIRS = [
  ".claude",
  ".codex",
  ".cursor",
  ".serena",
  ".gstack",
  ".hallmark",
  ".taste-skill",
  ".superpowers",
  ".playwright",
  ".playwright-mcp",
  "graphify-out",
  "test-results",
  "playwright-report",
  "blob-report",
  "coverage",
];

/** Folders the app reads or writes itself inside the container, which must stay visible. */
const APP_OWNED_DIRS = [".cache", ".eve", ".output", ".run", "src", "eve", "public", "scripts"];

function appServiceVolumes(): string[] {
  const block = compose.match(/^x-app-service: &app-service\n([\s\S]*?)^services:/m);
  expect(block, "x-app-service block found").not.toBeNull();
  const volumes = block![1].match(/^ {2}volumes:\n((?: {4}- .*\n|\s*#.*\n)+)/m);
  expect(volumes, "x-app-service volumes found").not.toBeNull();
  return volumes![1]
    .split("\n")
    .map((line) => line.match(/^ {4}- (\S+)/)?.[1])
    .filter((entry): entry is string => Boolean(entry));
}

function ignoredByGit(dir: string): boolean {
  return gitignore.split("\n").some((line) => line.trim().replace(/^\//, "").replace(/\/$/, "") === dir);
}

describe("dev stack watcher masks", () => {
  const volumes = appServiceVolumes();

  it.each(TOOL_OUTPUT_DIRS)("masks %s inside the web and worker containers", (dir) => {
    expect(volumes).toContain(`/app/${dir}`);
  });

  it.each(TOOL_OUTPUT_DIRS)("%s is gitignored, so masking it hides nothing tracked", (dir) => {
    expect(ignoredByGit(dir)).toBe(true);
  });

  it("masks nothing but the listed tool-output folders", () => {
    const masks = volumes.filter((entry) => entry.startsWith("/app/") && !/^\/app\/(node_modules|\.next)$/.test(entry));
    expect(masks.sort()).toEqual(TOOL_OUTPUT_DIRS.map((dir) => `/app/${dir}`).sort());
  });

  it.each(APP_OWNED_DIRS)("leaves %s visible to the app", (dir) => {
    expect(volumes).not.toContain(`/app/${dir}`);
  });

  it("keeps the repo bind mount itself", () => {
    expect(volumes).toContain(".:/app");
  });
});
