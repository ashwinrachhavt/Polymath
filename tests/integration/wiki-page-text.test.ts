import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { artifactKind, artifactVersions, artifacts, wikiPages } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { getWikiPageText } from "@/domains/knowledge/wiki";

/*
 * The wiki stamp on /artifacts/<id>: a wiki page is an artifact of kind
 * "note" claimed by the wiki_pages registry. The reader returns the
 * registered page's current version; a plain note, another workspace's page
 * or a malformed id is a miss, so the detail page renders no wiki stamp.
 */

suite("getWikiPageText (Neon)", () => {
  let auth: ReturnType<typeof ownerAuth>;
  let wikiId: string;
  let plainId: string;

  async function insertArtifact(input: {
    workspaceId: string;
    userId: string;
    kind: (typeof artifactKind.enumValues)[number];
    title: string;
    text: string;
  }): Promise<string> {
    const [row] = await holder
      .db!.insert(artifacts)
      .values({
        workspaceId: input.workspaceId,
        kind: input.kind,
        title: input.title,
        status: "reviewed",
        createdBy: input.userId,
        updatedBy: input.userId,
      })
      .returning({ id: artifacts.id });
    const [version] = await holder
      .db!.insert(artifactVersions)
      .values({
        workspaceId: input.workspaceId,
        artifactId: row.id,
        versionNumber: 1,
        content: { text: input.text },
        plainText: input.text,
        reason: "created",
        createdBy: input.userId,
      })
      .returning({ id: artifactVersions.id });
    await holder.db!.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, row.id));
    return row.id;
  }

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    const seed = await seedWorkspace(handle.db, `wiki-text-${Date.now()}`);
    auth = ownerAuth(seed.userId, seed.workspaceId);
    const owner = { workspaceId: auth.workspaceId, userId: auth.userId };
    wikiId = await insertArtifact({ ...owner, kind: "note", title: "Topic: research", text: "A wiki article body." });
    await holder.db!.insert(wikiPages).values({
      workspaceId: auth.workspaceId,
      role: "article",
      artifactId: wikiId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    plainId = await insertArtifact({ ...owner, kind: "note", title: "Brain dump", text: "A human note body." });
  });

  it("returns the registered page's current version", async () => {
    if (!handle) return;
    expect(await getWikiPageText(auth, wikiId)).toMatchObject({
      title: "Topic: research",
      plainText: "A wiki article body.",
      versionNumber: 1,
    });
  });

  it("is a miss for a plain note, a malformed id, and another workspace", async () => {
    if (!handle) return;
    expect(await getWikiPageText(auth, plainId)).toBeNull();
    expect(await getWikiPageText(auth, "not-a-uuid")).toBeNull();
    const other = await seedWorkspace(handle.db, `wiki-text-other-${Date.now()}`);
    expect(await getWikiPageText(ownerAuth(other.userId, other.workspaceId), wikiId)).toBeNull();
  });
});
