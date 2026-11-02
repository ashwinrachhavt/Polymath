import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

import { waitSettled } from "./helpers/settled";

/*
 * The scan-to-brief journey (Workbench D3) against fixture agent folders:
 * the golden unit fixtures (the same hand-authored transcripts the parser
 * tests read) are written into the roots the server was started with
 * (POLYMATH_AGENT_ARTIFACT_ROOTS), a project claims the transcripts' cwd,
 * and the operator scans from the project page, opens both briefs, and
 * re-scans to prove idempotence. The secret-shaped values the fixtures
 * embed must never reach the rendered pages — that is the redaction
 * promise, proven on the real surface.
 *
 * Self-skips without AGENT_SESSIONS_E2E=1 (the shutdown-ritual pattern): a
 * global roots override would point every other journey's scan at nothing
 * in particular, and the dev server must be booted with the roots env for
 * the scan to see the fixtures. The CI invocation below the main shards
 * runs this spec with both set; a local run is:
 *
 *   AGENT_SESSIONS_E2E=1 \
 *   POLYMATH_AGENT_ARTIFACT_ROOTS="claude-code=/tmp/e2e-agent-roots/claude;codex=/tmp/e2e-agent-roots/codex" \
 *   DATABASE_URL=... pnpm exec playwright test agent-sessions-fixture
 *
 * The repo path the fixtures claim is a fixed, nowhere-real path: the scan
 * reads the agent folders, never this path's contents.
 */

const FIXTURE_REPO = "/tmp/polymath-e2e-fixture-repo";
const NOTE = "Auth flake hunt before the demo build (e2e fixture note)";
const SLUG = "-tmp-polymath-e2e-fixture-repo-DECOY9z";
const CODEX_THREAD = "11111111-2222-3333-4444-555555555555";

const SECRETS = ["sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "hunter2secret", "sk-abc123def4567890"];

function db(): postgres.Sql | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // no .env
    }
  }
  return process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 1 }) : null;
}

/** The roots the dev server was started with, parsed like the scanner parses them. */
function fixtureRoots(): { "claude-code": string; codex: string } | null {
  const override = process.env.POLYMATH_AGENT_ARTIFACT_ROOTS;
  if (!override) return null;
  const roots: { "claude-code": string; codex: string } = { "claude-code": "", codex: "" };
  for (const part of override.split(";")) {
    const [name, value] = part.split("=", 2);
    if (name === "claude-code" && value) roots["claude-code"] = value;
    if (name === "codex" && value) roots.codex = value;
  }
  if (!roots["claude-code"] || !roots.codex) return null;
  return roots;
}

/** The golden unit transcripts, rewritten to claim the fixture repo path. */
function transcript(raw: string): string {
  return raw.replaceAll("/home/pino/Polymath", FIXTURE_REPO);
}

const seededProjectId: string[] = [];

test.skip(
  process.env.AGENT_SESSIONS_E2E !== "1",
  "agent-sessions fixture journey needs AGENT_SESSIONS_E2E=1 and roots env",
);

test.beforeAll(async () => {
  const roots = fixtureRoots();
  test.skip(!roots, "POLYMATH_AGENT_ARTIFACT_ROOTS must name both fixture roots");

  // Fixture trees at the documented layouts (art_GNwwKckZ §2): Claude Code
  // under projects/<slug>/<sessionId>.jsonl, Codex under
  // sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl. The slug embeds a
  // decoy: any scanner that decoded it would show the decoy, not the cwd.
  const fixtures = "tests/fixtures/agent-artifacts";
  const claudeDir = join(roots["claude-code"], "projects", SLUG);
  const codexDir = join(roots.codex, "sessions", "2026", "11", "01");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "sess-111.jsonl"),
    transcript(readFileSync(join(fixtures, "claude-code/session-with-replay.jsonl"), "utf8")),
  );
  writeFileSync(
    join(codexDir, `rollout-2026-11-01T09-00-00-${CODEX_THREAD}.jsonl`),
    transcript(readFileSync(join(fixtures, `codex/rollout-2026-11-01T09-00-00-${CODEX_THREAD}.jsonl`), "utf8")),
  );
  writeFileSync(
    join(codexDir, `rollout-2026-11-01T09-05-00-${CODEX_THREAD}.jsonl`),
    transcript(readFileSync(join(fixtures, `codex/rollout-2026-11-01T09-05-00-${CODEX_THREAD}.jsonl`), "utf8")),
  );

  // The project that claims the fixture repo path. Same database, same
  // schema the server reads; registered for cleanup like the run seeds.
  const client = db();
  test.skip(!client, "no database configured");
  try {
    const [owner] = await client!<{ workspace_id: string }[]>`
      select m.workspace_id from memberships m
      join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1
    `;
    test.skip(!owner, "dev owner not provisioned yet");
    const [project] = await client!<{ id: string }[]>`
      insert into notebooks (workspace_id, title, repo_path)
      values (${owner!.workspace_id}, 'E2E fixture repo', ${FIXTURE_REPO})
      returning id
    `;
    seededProjectId.push(project!.id);
  } finally {
    await client?.end();
  }
});

test.afterAll(async () => {
  const client = db();
  if (!client || seededProjectId.length === 0) return;
  try {
    // The imported sessions this run wrote (identified by the fixtures'
    // external ids) and the seeded project, so a re-run starts from the
    // empty state and the shared suite database stays uncluttered.
    await client`delete from imported_agent_sessions where external_session_id in ('sess-111', ${CODEX_THREAD})`;
    await client`delete from notebooks where id = any(${seededProjectId})`;
  } finally {
    await client.end();
  }
});

test("scanning fixture folders surfaces both sessions and their briefs", async ({ page }) => {
  test.setTimeout(180_000);

  // The project page's "Agent sessions" section opens on the empty state —
  // the section exists before any scan, and says what to do.
  await page.goto(`/projects/${seededProjectId[0]}`);
  await waitSettled(page);
  const section = page.getByRole("region", { name: "Agent sessions", exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByText("No agent sessions scanned for this folder yet.")).toBeVisible();

  // The scan: an optional decision note typed here is what makes the
  // sessions' decision "recorded" rather than inferred. The Codex resume
  // rollout groups into the same session, so the scan imports exactly two.
  await section.getByLabel("Decision note for these sessions (optional)").fill(NOTE);
  await section.getByRole("button", { name: "Scan agent sessions" }).click();
  await expect(section.getByText(/2 imported/)).toBeVisible({ timeout: 60_000 });

  // Both sources render, named by their product, matched by cwd.
  const claudeRow = section.getByRole("link", { name: "Fix flaky login" });
  const codexRow = section.getByRole("link", { name: CODEX_THREAD });
  await expect(claudeRow).toBeVisible();
  await expect(codexRow).toBeVisible();
  await expect(section.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect(section.getByText("Codex", { exact: true })).toBeVisible();

  // Nothing secret reached even the section: the fixtures embed a staging
  // key, a password, and an API token inside prompts and tool output.
  const body = await page.locator("body").innerText();
  for (const secret of SECRETS) expect(body).not.toContain(secret);

  // The Claude Code brief: requested outcome, the recorded note, the
  // standing unverified line, and the mandatory disclosure.
  await claudeRow.click();
  await waitSettled(page);
  await expect(page).toHaveURL(new RegExp(`/projects/${seededProjectId[0]}/agent-sessions/`));
  await expect(page.getByText("Fix the flaky login test")).toBeVisible();
  await expect(page.getByText(NOTE)).toBeVisible();
  await expect(page.getByText("rationale inferred after implementation")).toHaveCount(0);
  await expect(
    page.getByText("Agent claims are unverified: a transcript shows what ran, not what worked."),
  ).toBeVisible();
  await expect(
    page.getByText("Parsed locally from your Claude Code / Codex files. Nothing was sent to a model."),
  ).toBeVisible();
  // Activity and failures from the paired tool calls, with the secret gone.
  await expect(page.getByText("src/login.ts")).toBeVisible();
  await expect(page.getByText("FAIL login.test.ts")).toBeVisible();
  const briefBody = await page.locator("body").innerText();
  for (const secret of SECRETS) expect(briefBody).not.toContain(secret);

  // The Codex brief: the injected blocks and the "My request for Codex"
  // prefix are stripped before the text is treated as a human prompt — the
  // outcome line carries only what the person typed. The requested outcome
  // is the first prompt; the resume's follow-up turns live at the parser
  // level (the parser unit tests assert the full filtered prompt list).
  await page.goto(`/projects/${seededProjectId[0]}`);
  await waitSettled(page);
  await section.getByRole("link", { name: CODEX_THREAD }).click();
  await waitSettled(page);
  await expect(page.getByText("Ship the parser, skip the docs.")).toBeVisible();
  // Redaction replaced the secret in the rendered outcome, not merely hid it.
  await expect(page.getByText(/Staging key \[redacted\]/)).toBeVisible();
  const codexBody = await page.locator("body").innerText();
  for (const gone of ["AGENTS.md rules the agent injected", "environment_context", "## My request for Codex"]) {
    expect(codexBody).not.toContain(gone);
  }

  // Re-scan is idempotent: same sessions, no duplicate rows.
  await page.goto(`/projects/${seededProjectId[0]}`);
  await waitSettled(page);
  const sectionAgain = page.getByRole("region", { name: "Agent sessions", exact: true });
  await sectionAgain.getByRole("button", { name: "Scan agent sessions" }).click();
  await expect(sectionAgain.getByText(/0 imported · 2 updated/)).toBeVisible({ timeout: 60_000 });
  await expect(sectionAgain.getByRole("link", { name: "Fix flaky login" })).toHaveCount(1);
  await expect(sectionAgain.getByRole("link", { name: CODEX_THREAD })).toHaveCount(1);

  // The settings panel names both sources and sees the fixture roots.
  await page.goto("/settings");
  await waitSettled(page);
  await expect(page.getByText("Local agent sessions")).toBeVisible();
  await expect(page.getByText("Claude Code", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("present", { exact: true })).toHaveCount(2);
});
