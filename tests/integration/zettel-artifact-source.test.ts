import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The artifact path of direct creation (plan Task 15): a conversation
 * artifact mined for ideas creates cards whose provenance is the source
 * artifact, never a document; a quote that is not a verbatim passage of the
 * artifact's body is dropped; and the card's source edge points at the
 * artifact itself.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

const TEXT =
  "The tenant pays monthly rent of twelve hundred dollars.\n\nThe landlord keeps the security deposit until move out.";
const Q1 = "The tenant pays monthly rent of twelve hundred dollars.";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

/** A fresh workspace holding one note artifact whose body is `text`. */
async function seedTextNote(label: string, text = TEXT) {
  const db = holder.db!;
  const seed = await seedWorkspace(db, `zart-${label}-${Date.now()}`);
  const auth = ownerAuth(seed.userId, seed.workspaceId);
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: "note",
      title: "Lease chat",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { format: "markdown", text },
      plainText: text,
      reason: "created",
      createdBy: auth.userId,
    })
    .returning();
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  return { auth, artifactId: artifact.id };
}

suite("createZettelsFromSource from an artifact (real Postgres)", () => {
  it("creates artifact-sourced cards and drops invented quotes", async () => {
    const { auth, artifactId } = await seedTextNote("source");
    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    const extractor = {
      name: "fake@1",
      extract: async () => [
        { title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 },
        {
          title: "Invented",
          content: "Not in the body.",
          quote: "this sentence is not in the artifact anywhere at all",
        },
      ],
    };

    const { created } = await createZettelsFromSource(auth, { sourceArtifactId: artifactId, extractor });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ artifactId: expect.any(String), title: "Monthly rent" });

    const [card] = await holder.db!.select().from(artifacts).where(eq(artifacts.id, created[0]!.artifactId));
    const key = (card.metadata as { dedupeKey?: string } | null)?.dedupeKey;
    expect(key).toMatch(new RegExp(`^zettel:artifact:${artifactId}:\\d+-\\d+$`));

    // A second identical run lands on the same-span gate: the card for this
    // span already exists, so the repeat stacks nothing.
    const again = await createZettelsFromSource(auth, { sourceArtifactId: artifactId, extractor });
    expect(again.created).toEqual([]);
  });

  it("refuses a source with no readable body", async () => {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `zart-empty-${Date.now()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
    // An artifact with no version carries no readable body at all.
    const [artifact] = await db
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "note",
        title: "Empty",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();

    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    await expect(
      createZettelsFromSource(auth, {
        sourceArtifactId: artifact.id,
        extractor: { name: "fake@1", extract: async () => [] },
      }),
    ).rejects.toThrow("artifact has no readable text");
  });

  it("creates an artifact-sourced card with the edge pointing at the artifact", async () => {
    const { auth, artifactId } = await seedTextNote("accept");
    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    const extractor = {
      name: "fake@1",
      extract: async () => [{ title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 }],
    };

    const { created } = await createZettelsFromSource(auth, { sourceArtifactId: artifactId, extractor });
    const [card] = await holder.db!
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(and(eq(artifacts.id, created[0]!.artifactId), eq(artifacts.workspaceId, auth.workspaceId)));
    expect(card?.title).toBe("Monthly rent");

    const edges = await holder.db!
      .select({
        targetType: artifactLinks.targetType,
        targetId: artifactLinks.targetId,
        linkType: artifactLinks.linkType,
      })
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, created[0]!.artifactId), eq(artifactLinks.linkType, "source")));
    expect(edges).toEqual([{ targetType: "artifact", targetId: artifactId, linkType: "source" }]);
  });
});
