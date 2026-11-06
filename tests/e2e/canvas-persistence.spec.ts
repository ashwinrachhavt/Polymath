import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

/*
 * The canonical canvas route's visual smoke (PR #536): a Postgres-persisted
 * canvas loads into the Excalidraw editor, an edit saves as an appended
 * version, and a non-editable diagram type keeps the editor disabled behind
 * its SVG image fallback. Screenshots ride the Playwright JSON report as
 * attachments so CI's e2e-report artifact carries the pixels, not just the
 * verdicts. Seeding is SQL (learn-loop's pattern): the journey exercises the
 * route and the save action, not the generation pipeline.
 */

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

const client = db();
test.skip(!client, "DATABASE_URL not configured (server and test).");

async function seedCanvas(input: { title: string; mermaid: string; diagramType: string }): Promise<string> {
  const [owner] = await client!<{ workspace_id: string; user_id: string }[]>`
    select m.workspace_id, m.user_id
    from memberships m join users u on u.id = m.user_id
    where u.clerk_user_id = 'dev-user' and m.status = 'active'
    limit 1`;
  if (!owner) throw new Error("dev-user workspace missing (global-setup should provision it)");
  const tag = Date.now().toString(36);
  const [artifact] = await client!<{ id: string }[]>`
    insert into artifacts (workspace_id, kind, title, status, created_by, updated_by)
    values (${owner.workspace_id}, 'diagram', ${`${input.title} ${tag}`}, 'generated', ${owner.user_id}, ${owner.user_id})
    returning id`;
  const [canvas] = await client!<{ id: string }[]>`
    insert into canvases (workspace_id, artifact_id, title, created_by, updated_by)
    values (${owner.workspace_id}, ${artifact.id}, ${`${input.title} ${tag}`}, ${owner.user_id}, ${owner.user_id})
    returning id`;
  await client!`
    insert into canvas_versions (workspace_id, canvas_id, version_number, scene, created_by)
    values (
      ${owner.workspace_id}, ${canvas.id}, 1,
      ${client!.json({ format: "mermaid", mermaid: input.mermaid, diagramType: input.diagramType })},
      ${owner.user_id}
    )`;
  return canvas.id;
}

async function shot(page: Page, name: string, attach: (name: string, body: Buffer) => Promise<void>): Promise<void> {
  await attach(name, await page.screenshot({ fullPage: true }));
}

test("a persisted mermaid canvas loads into the editor and saves as an appended version", async ({
  page,
}, testInfo) => {
  const canvasId = await seedCanvas({
    title: "E2E flowchart canvas",
    mermaid: "flowchart TD\n  A[Capture] --> B[Extract]\n  B --> C[Connect]",
    diagramType: "flowchart",
  });
  const attach = (name: string, body: Buffer) => testInfo.attach(name, { body, contentType: "image/png" });

  await page.goto(`/polymath/canvas/${canvasId}`);
  // The status flips to the editable copy in the same commit that mounts the
  // island; assert it first so a slow Excalidraw chunk cannot starve it.
  await expect(page.getByText(/Canonical canvas v1/)).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 60_000 });
  await shot(page, "canvas-editable-loaded", attach);

  // An edit (the title field) dirties the canvas; saving appends v2.
  await page.getByLabel("Canvas title").fill("E2E flowchart canvas (edited)");
  const save = page.getByRole("button", { name: "Save canvas checkpoint" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Checkpoint saved as version 2\./)).toBeVisible({ timeout: 30_000 });
  await shot(page, "canvas-editable-after-save", attach);

  // The append landed in Postgres as an Excalidraw-envelope version; a reload
  // reads v2 from the chain, not from any browser-local state.
  const versions = await client!<{ version_number: number; format: string }[]>`
    select version_number, scene->>'format' as format
    from canvas_versions where canvas_id = ${canvasId} order by version_number`;
  expect(versions.map((v) => [v.version_number, v.format])).toEqual([
    [1, "mermaid"],
    [2, "excalidraw"],
  ]);
  await page.reload();
  await expect(page.getByText(/Canonical canvas v2/)).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 60_000 });
  await shot(page, "canvas-editable-reloaded-v2", attach);
});

test("a non-editable diagram type keeps the editor disabled behind the SVG image fallback", async ({
  page,
}, testInfo) => {
  const canvasId = await seedCanvas({
    title: "E2E er canvas",
    mermaid: "erDiagram\n  WORKSPACE ||--o{ DOCUMENT : holds\n  DOCUMENT ||--o{ EXTRACTION : yields",
    diagramType: "er",
  });
  const attach = (name: string, body: Buffer) => testInfo.attach(name, { body, contentType: "image/png" });

  await page.goto(`/polymath/canvas/${canvasId}`);
  await expect(page.getByText("Read-only image preview", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/er diagrams open as an image, not an editable scene/)).toBeVisible();
  // The mermaid SVG renders as the preview; the editor and its save path
  // never mount for this version.
  await expect(page.locator("svg").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".excalidraw")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save canvas checkpoint" })).toHaveCount(0);
  await shot(page, "canvas-image-fallback", attach);
});
