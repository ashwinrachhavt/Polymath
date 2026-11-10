import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Margin notes read a linked note's first paragraph by its [[title]]: match
 * is case-insensitive, scoped to the caller's workspace, never archived, and
 * shows what was last typed (the autosaved draft) rather than the checkpoint.
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

  it("reads the autosaved draft, not the last checkpoint", async () => {
    const auth = await seed("previews-draft");
    const created = await notes.createNote(auth, {
      title: "Alpha",
      content: markdown("Checkpointed words."),
      idempotencyKey: crypto.randomUUID(),
    });
    await notes.autosaveNoteDraft(auth, {
      artifactId: created.id,
      expectedVersion: created.version,
      content: markdown("Typed since the checkpoint."),
      idempotencyKey: crypto.randomUUID(),
    });
    const [preview] = await notes.getLinkPreviews(auth, ["Alpha"]);
    expect(preview.firstParagraph).toBe("Typed since the checkpoint.");
  });

  it("never previews an archived note", async () => {
    const auth = await seed("previews-archived");
    const created = await notes.createNote(auth, {
      title: "Alpha",
      content: markdown("Gone."),
      idempotencyKey: crypto.randomUUID(),
    });
    await db.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, created.id));
    expect(await notes.getLinkPreviews(auth, ["Alpha"])).toEqual([]);
  });

  it("picks the oldest of two notes with the same title", async () => {
    const auth = await seed("previews-duplicate");
    const first = await notes.createNote(auth, {
      title: "Alpha",
      content: markdown("The first."),
      idempotencyKey: crypto.randomUUID(),
    });
    await notes.createNote(auth, {
      title: " alpha",
      content: markdown("The second."),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await notes.getLinkPreviews(auth, ["ALPHA"])).toEqual([
      { title: "Alpha", id: first.id, firstParagraph: "The first." },
    ]);
  });

  it("drops a heading that repeats the title, task boxes and escapes", async () => {
    const auth = await seed("previews-markup");
    await notes.createNote(auth, {
      title: "Alpha",
      content: markdown("# Alpha\n\n- [ ] Buy \\*two\\* things\n- [x] Done"),
      idempotencyKey: crypto.randomUUID(),
    });
    const [preview] = await notes.getLinkPreviews(auth, ["Alpha"]);
    expect(preview.firstParagraph).toBe("Buy *two* things Done");
  });

  it("returns [] for an unknown title", async () => {
    const auth = await seed("previews-unknown");
    expect(await notes.getLinkPreviews(auth, ["Nothing here"])).toEqual([]);
    expect(await notes.getLinkPreviews(auth, [])).toEqual([]);
  });
});
