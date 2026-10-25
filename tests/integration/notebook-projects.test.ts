import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notebooks, notebookSources, sources } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Regression for ASH-270: 0248 renamed the dossier tables to notebooks but
 * left their FK columns as dossier_id, so every notebookSources query failed
 * with "column ps.notebook_id does not exist" and /projects 500'd. This runs
 * the real listProjects query against a migrated database; CI builds its
 * test database from the migration chain, so schema/query drift here fails
 * the suite.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let queries: typeof import("@/domains/knowledge/projects");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  queries = await import("@/domains/knowledge/projects");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("notebook projects list", () => {
  it("lists notebooks with their source counts", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `nb-proj-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const [notebook] = await db
      .insert(notebooks)
      .values({ workspaceId, title: "Move research", description: "Everything for the move." })
      .returning({ id: notebooks.id });
    const [source] = await db
      .insert(sources)
      .values({ workspaceId, kind: "web", title: "Lease guide", url: `https://example.com/${Date.now()}` })
      .returning({ id: sources.id });
    await db.insert(notebookSources).values({ workspaceId, notebookId: notebook.id, sourceId: source.id });

    const items = await queries.listProjects(auth);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: notebook.id, title: "Move research", documentCount: 1 });
  });
});
