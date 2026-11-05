import { expect, test } from "@playwright/test";
import postgres from "postgres";

/*
 * Zettel alchemy playground (art_4TAwJpNT): the crucible on /polymath/graph.
 * Seed cards via SQL (local-write-card.spec.ts pattern — no Ideas-surface
 * fixtures), toggle them into the crucible, and mix: the synthesis must land
 * on the canvas as a selected node with one source edge per parent, and stay
 * playable in a second mix. Connect — from the panel and from a drag — must
 * leave a related edge that survives a reload. Source-edge and node-insertion
 * assertions only; the tag-union lives in PR #523's integration tests.
 *
 * The two journeys share the dev owner's workspace graph, so they run
 * serially: fullyParallel would race their edge-count assertions.
 */

test.describe.configure({ mode: "serial" });

// One suffix per run keeps retries from colliding with rows a failed attempt
// left behind: the private db is reset per run, but a retry re-seeds it.
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const cardTitle = (name: string) => `Alchemy ${name} ${run}`;

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

async function seedCards(names: string[]): Promise<{ title: string; id: string }[]> {
  const client = db();
  if (!client) throw new Error("DATABASE_URL not configured — the private-DB pattern requires it");
  const titles = names.map(cardTitle);
  const created: string[] = [];
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1`;
    if (!owner) throw new Error("dev-user workspace not provisioned (global-setup should have run)");
    await client.begin(async (tx) => {
      for (const title of titles) {
        const [art] = await tx<{ id: string }[]>`
          insert into artifacts (workspace_id, kind, title)
          values (${owner.workspace_id}, 'note', ${title})
          returning id`;
        const [ver] = await tx<{ id: string }[]>`
          insert into artifact_versions (workspace_id, artifact_id, version_number, content, plain_text)
          values (${owner.workspace_id}, ${art.id}, 1, ${JSON.stringify({ format: "markdown", text: `Body of ${title}.` })}::jsonb, ${`Body of ${title}.`})
          returning id`;
        await tx`update artifacts set current_version_id = ${ver.id} where id = ${art.id}`;
        created.push(art.id);
      }
    });
  } finally {
    await client.end();
  }
  return titles.map((title, i) => ({ title, id: created[i] }));
}

// The optimistic temp edge appears before linkCardsAction commits, so a
// reload can race the in-flight action and lose the row. Wait for the
// persisted row instead — this is the honest signal that connect survived.
async function expectLinkRows(ids: string[], n: number): Promise<void> {
  const client = db();
  if (!client) throw new Error("DATABASE_URL not configured");
  try {
    await expect
      .poll(
        async () => {
          const [row] = await client<{ n: number }[]>`
            select count(*)::int as n from artifact_links
            where link_type = 'related'
              and (artifact_id = any(${ids}) or target_id = any(${ids}))`;
          return row?.n ?? 0;
        },
        { timeout: 15_000, message: `expected ${n} persisted related link row(s)` },
      )
      .toBe(n);
  } finally {
    await client.end();
  }
}

test("crucible mixes three cards into a selected synthesis node and stays playable", async ({ page }) => {
  test.setTimeout(180_000);
  const titles = (await seedCards(["Alpha", "Beta", "Gamma"])).map((c) => c.title);
  await page.goto("/polymath/graph");

  for (const title of titles) {
    await page.getByRole("button", { name: `Add ${title} to the crucible` }).click();
  }
  await expect(page.getByRole("button", { name: "Crucible · 3 selected" })).toBeVisible();

  await page.getByLabel("New idea title").fill("Alchemy Synthesis");
  await page.getByRole("button", { name: "Mix", exact: true }).click();

  const synthesis = page.locator(".react-flow__node.selected", { hasText: "Alchemy Synthesis" });
  await expect(synthesis).toBeVisible();
  await expect(page.locator(".react-flow__edge", { hasText: "derived from" })).toHaveCount(3);
  await expect(page.getByRole("button", { name: /Crucible · \d+ selected/ })).toHaveCount(0);

  // Keep playing: the synthesis itself goes back into the crucible.
  await page.getByRole("button", { name: `Add ${titles[0]} to the crucible` }).click();
  await page.getByRole("button", { name: `Add ${titles[1]} to the crucible` }).click();
  await page.getByRole("button", { name: `Add Alchemy Synthesis to the crucible` }).click();
  await expect(page.getByRole("button", { name: "Crucible · 3 selected" })).toBeVisible();

  await page.getByLabel("New idea title").fill("Alchemy Synthesis II");
  await page.getByRole("button", { name: "Mix", exact: true }).click();
  await expect(page.locator(".react-flow__node.selected", { hasText: "Alchemy Synthesis II" })).toBeVisible();
  // Three source edges per mix: the first synthesis's stay, too.
  await expect(page.locator(".react-flow__edge", { hasText: "derived from" })).toHaveCount(6);
});

test("crucible connect and drag-connect leave edges that survive a reload", async ({ page }) => {
  test.setTimeout(180_000);
  const cards = await seedCards(["Delta", "Epsilon", "Zeta", "Eta"]);
  const titles = cards.map((c) => c.title);
  await page.goto("/polymath/graph");

  // Panel connect on two crucible cards.
  await page.getByRole("button", { name: `Add ${titles[0]} to the crucible` }).click();
  await page.getByRole("button", { name: `Add ${titles[1]} to the crucible` }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expectLinkRows(
    cards.map((c) => c.id),
    1,
  );
  await expect(page.locator(".react-flow__edge", { hasText: "related" })).toHaveCount(1);

  // Drag from Zeta's source handle onto Eta's target handle.
  const source = page.locator(".react-flow__node", { hasText: titles[2] }).locator(".react-flow__handle.source");
  const target = page.locator(".react-flow__node", { hasText: titles[3] }).locator(".react-flow__handle.target");
  await source.hover();
  await page.mouse.down();
  await target.hover();
  await page.mouse.up();
  await expectLinkRows(
    cards.map((c) => c.id),
    2,
  );
  await expect(page.locator(".react-flow__edge", { hasText: "related" })).toHaveCount(2);

  // Both links are real rows: a reload re-derives the same edges from the db.
  await page.reload();
  await expect(page.locator(".react-flow__edge", { hasText: "related" })).toHaveCount(2);
});
