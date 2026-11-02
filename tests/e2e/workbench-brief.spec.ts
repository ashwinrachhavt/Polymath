import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { removeSeededRuns, seedRun } from "./helpers/runs";
import { waitSettled } from "./helpers/settled";

/*
 * Workbench D2: after a capture, the run detail page renders the evidence-tiered
 * change brief as a panel above the transcript — and a run without a checkpoint
 * renders without one. The fixture drives the REAL capture path (the workbench:capture
 * script over a shell-made git change), so the page is read through the same
 * write→store→read flow the product uses.
 */

const REPO_ROOT = join(__dirname, "..");

/** The linked project's stated outcome, rendered by the brief's outcome section. */
const OUTCOME = "Simplify the Ideas grid to one filter.";
// The disclosure line's exact copy is pinned against the constant by the unit
// panel test; the e2e asserts the rendered text a reader sees.
const DISCLOSURE = "Captured locally from git state and provided test results. Nothing was sent to a model.";

let briefRunId: string | null = null;
let plainRunId: string | null = null;

test.beforeAll(async () => {
  const briefRun = await seedRun({ objective: "workbench brief e2e — Ideas surface", state: "succeeded" });
  briefRunId = briefRun?.id ?? null;
  const plainRun = await seedRun({ objective: "workbench brief e2e — no checkpoint", state: "succeeded" });
  plainRunId = plainRun?.id ?? null;

  if (!briefRunId) return;

  // A fixture repo with one shell-made (sed) change: the capture must see real
  // git state, not editor events.
  const repoPath = mkdtempSync(join(tmpdir(), "wb-e2e-"));
  execFileSync("git", ["init", "-b", "main", repoPath]);
  for (const [key, value] of [["user.email", "fixture@example.com"], ["user.name", "Fixture"]]) {
    execFileSync("git", ["-C", repoPath, "config", key, value]);
  }
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/acme/fixture.git"]);
  const filePath = join(repoPath, "app.ts");
  writeFileSync(filePath, "export const value = 'before';\n");
  execFileSync("git", ["-C", repoPath, "add", "."]);
  execFileSync("git", ["-C", repoPath, "commit", "-m", "base"]);
  const baseSha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("sed", ["-i", "s/before/after/", filePath]);
  execFileSync("git", ["-C", repoPath, "add", "."]);
  execFileSync("git", ["-C", repoPath, "commit", "-m", "simplify ideas grid"]);

  const resultsPath = join(mkdtempSync(join(tmpdir(), "wb-e2e-results-")), "test-results.json");
  writeFileSync(
    resultsPath,
    JSON.stringify([
      { name: "ideas grid renders", ok: true },
      { name: "ideas filters apply", ok: false },
    ]),
  );

  // Link a project subject onto the run so the brief reads its stated outcome,
  // the way a real run carries its project.
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // Stay unseeded; the tests skip on the null ids.
    }
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active' limit 1`;
    const [project] = await client<{ id: string }[]>`
      insert into projects (workspace_id, name, intended_outcome, created_by, updated_by)
      select ${owner.workspace_id}, 'Ideas surface', ${OUTCOME}, u.id, u.id
      from users u where u.clerk_user_id = 'dev-user' limit 1
      returning id`;
    await client`update agent_runs set subjects = ${JSON.stringify([{ type: "project", id: project.id }])}::jsonb where id = ${briefRunId}`;
  } finally {
    await client.end();
  }

  // The real capture: dry-run off (--apply), mechanical, no LLM.
  execFileSync("pnpm", [
    "workbench:capture", "--apply",
    "--repo", repoPath, "--base", baseSha,
    "--run", briefRunId,
    "--test-results", resultsPath,
    "--decision", "Recorded during the experiment: ship the simplified grid.",
  ], { cwd: REPO_ROOT });
});

test.afterAll(async () => {
  await removeSeededRuns();
});

test("a run with a checkpoint renders the change brief above the transcript", async ({ page }) => {
  test.skip(!briefRunId, "Seeding a run needs DATABASE_URL.");

  await page.goto(`/polymath/${briefRunId}`);
  await waitSettled(page);

  const brief = page.getByRole("region", { name: "Change brief" });
  await expect(brief).toBeVisible();

  // Requested outcome: recorded, from the linked project's intended outcome.
  const outcome = brief.locator("div", { has: page.locator("h3", { hasText: "Requested outcome" }) }).first();
  await expect(outcome).toContainText(OUTCOME);

  // Captured tests render at the verified tier, failures loud.
  await expect(brief).toContainText("1 passed · 1 failed");
  await expect(brief).toContainText("ideas filters apply");

  // The recorded decision, and the standing disclosure line.
  await expect(brief).toContainText("Recorded during the experiment: ship the simplified grid.");
  await expect(brief).toContainText(DISCLOSURE);

  // The diff stays collapsed until the reader opens it, then shows the bytes.
  await expect(brief).toContainText(/View diff \(\d+ lines\)/);
  await page.getByText(/View diff \(\d+ lines\)/).click();
  await expect(brief).toContainText("+export const value = 'after';");
});

test("a run without a checkpoint renders no change brief", async ({ page }) => {
  test.skip(!plainRunId, "Seeding a run needs DATABASE_URL.");

  await page.goto(`/polymath/${plainRunId}`);
  await waitSettled(page);

  await expect(page.getByRole("region", { name: "Change brief" })).toHaveCount(0);
});
