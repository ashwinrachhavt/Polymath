import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactLinks, artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The artifact path of the proposals seam (plan Task 15): a conversation
 * artifact mined for ideas writes rows whose origin is source_artifact_id,
 * never document_id; a quote that is not a verbatim passage of the artifact's
 * body is dropped; and accepting such a proposal still makes the zettel card,
 * with its source edge pointing at the artifact.
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

suite("proposeZettels from an artifact (real Postgres)", () => {
  it("writes artifact-sourced rows and drops invented quotes", async () => {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `zart-${Date.now()}`);
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
        content: { format: "markdown", text: TEXT },
        plainText: TEXT,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning();
    await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));

    const { proposeZettels } = await import("@/domains/knowledge/zettels");
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
    const { proposals: rows } = await proposeZettels(auth, { sourceArtifactId: artifact.id, extractor });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceArtifactId: artifact.id,
      documentId: null,
      extractionId: null,
      title: "Monthly rent",
    });
    expect(TEXT.slice(rows[0].spanStart, rows[0].spanEnd)).toBe(Q1);
    expect(rows[0].dedupeKey).toBe(`zettel:artifact:${artifact.id}:${rows[0].spanStart}-${rows[0].spanEnd}`);

    // A second identical run collides on the partial index, so the repeat
    // stacks nothing (the NULL-distinctness guarantee on the artifact path).
    const again = await proposeZettels(auth, { sourceArtifactId: artifact.id, extractor });
    expect(again.proposals).toHaveLength(0);
  });

  it("refuses a source with no readable body", async () => {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `zart-empty-${Date.now()}`);
    const auth = ownerAuth(seed.userId, seed.workspaceId);
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
    const { proposeZettels } = await import("@/domains/knowledge/zettels");
    await expect(
      proposeZettels(auth, { sourceArtifactId: artifact.id, extractor: { name: "fake@1", extract: async () => [] } }),
    ).rejects.toThrow("artifact has no readable text");
  });

  it("accepts an artifact-sourced proposal with the edge pointing at the artifact", async () => {
    const db = holder.db!;
    const seed = await seedWorkspace(db, `zart-accept-${Date.now()}`);
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
        content: { format: "markdown", text: TEXT },
        plainText: TEXT,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning();
    await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));

    const { proposeZettels, acceptZettel } = await import("@/domains/knowledge/zettels");
    const extractor = {
      name: "fake@1",
      extract: async () => [{ title: "Monthly rent", content: "Rent is $1,200 a month.", quote: Q1 }],
    };
    const {
      proposals: [proposal],
    } = await proposeZettels(auth, { sourceArtifactId: artifact.id, extractor });

    const accepted = await acceptZettel(auth, { proposalId: proposal.id });
    const [card] = await db
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(and(eq(artifacts.id, accepted.artifactId), eq(artifacts.workspaceId, auth.workspaceId)));
    expect(card?.title).toBe("Monthly rent");

    const edges = await db
      .select({
        targetType: artifactLinks.targetType,
        targetId: artifactLinks.targetId,
        linkType: artifactLinks.linkType,
      })
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, accepted.artifactId), eq(artifactLinks.linkType, "source")));
    expect(edges).toEqual([{ targetType: "artifact", targetId: artifact.id, linkType: "source" }]);
  });
});
