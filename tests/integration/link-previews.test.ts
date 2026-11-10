import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Margin notes read a linked note's first paragraph by its [[title]]: match
 * is case-insensitive, scoped to the caller's workspace, never archived.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let notes: typeof import("@/domains/knowledge/notes");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  notes = await import("@/domains/knowledge/notes");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

const markdown = (text: string) => ({ format: "markdown", text });

suite("getLinkPreviews", () => {
  it("returns the first paragraph for a linked title", async () => {
    const auth = await seed("previews-basic");
    const created = await notes.createNote(auth, {
      title: "Alpha",
      content: markdown("\n\nFirst **paragraph** here.\n\nSecond paragraph."),
      idempotencyKey: crypto.randomUUID(),
    });
    const result = await notes.getLinkPreviews(auth, ["alpha "]);
    expect(result).toEqual([{ title: "Alpha", id: created.id, firstParagraph: "First paragraph here." }]);
  });

  it("ignores another workspace's Alpha", async () => {
    const mine = await seed("previews-mine");
    const theirs = await seed("previews-theirs");
    await notes.createNote(theirs, {
      title: "Alpha",
      content: markdown("Not yours."),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await notes.getLinkPreviews(mine, ["Alpha"])).toEqual([]);
  });

  it("returns [] for an unknown title", async () => {
    const auth = await seed("previews-unknown");
    expect(await notes.getLinkPreviews(auth, ["Nothing here"])).toEqual([]);
    expect(await notes.getLinkPreviews(auth, [])).toEqual([]);
  });
});
