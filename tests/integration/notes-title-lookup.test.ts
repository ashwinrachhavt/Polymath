import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the evergreen reader resolves a [[Title]] by lookup, not from a capped index;
 * fails_when=the lookup becomes case-sensitive, crosses workspaces or returns archived cards;
 * why_new=findNotesByTitle is new; seam=none; no_claim=the reader's rendering of the result
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let notes: typeof import("@/domains/knowledge/notes");

beforeAll(async () => {
  if (!handle) return;
  notes = await import("@/domains/knowledge/notes");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(handle!.db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("findNotesByTitle", () => {
  it("finds cards by title whatever the case, in this workspace only", async () => {
    const mine = await seed("titles-mine");
    const theirs = await seed("titles-theirs");
    const wanted = await notes.createNote(mine, { title: "Evergreen Notes" });
    await notes.createNote(mine, { title: "Something else" });
    await notes.createNote(theirs, { title: "Evergreen notes" });

    const found = await notes.findNotesByTitle(mine, ["  evergreen notes ", "No such note", ""]);
    expect(found.map((note) => note.id)).toEqual([wanted.id]);
    expect(await notes.findNotesByTitle(mine, [])).toEqual([]);
  });

  it("skips archived cards and kinds a [[link]] cannot point at", async () => {
    const mine = await seed("titles-archived");
    const gone = await notes.createNote(mine, { title: "Old Idea" });
    await handle!.db.update(artifacts).set({ archivedAt: new Date() }).where(eq(artifacts.id, gone.id));
    await notes.createNote(mine, { title: "Old Idea", kind: "transcript" });
    expect(await notes.findNotesByTitle(mine, ["old idea"])).toEqual([]);
  });
});
