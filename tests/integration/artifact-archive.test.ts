import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=Delete with Undo on Ideas and Artifacts; fails_when=an archived idea still shows
 * in Ideas or the Artifacts gallery, Undo does not bring the same row back, one workspace can
 * archive or restore another's artifact, or the archive/restore is not audited; why_new=the delete
 * is new; seam=archiveArtifact/restoreArtifact against the real list queries; no_claim=the button
 * (tests/unit/idea-modal.test.tsx)
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let archive: typeof import("@/domains/knowledge/artifact-archive");
let notes: typeof import("@/domains/knowledge/notes");
let zettels: typeof import("@/domains/knowledge/zettels");
let gallery: typeof import("@/domains/knowledge/artifact-gallery");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  archive = await import("@/domains/knowledge/artifact-archive");
  notes = await import("@/domains/knowledge/notes");
  zettels = await import("@/domains/knowledge/zettels");
  gallery = await import("@/domains/knowledge/artifact-gallery");
});

afterAll(async () => {
  await handle?.client.end();
});

async function ideaIn(name: string) {
  const seeded = await seedWorkspace(db, `${name}-${Date.now()}`);
  const auth = ownerAuth(seeded.userId, seeded.workspaceId);
  const idea = await notes.createNote(auth, {
    idempotencyKey: `${name}-idea`,
    title: "Constraints make better designs",
    plainText: "A tight constraint forces a choice.",
    kind: "zettel",
  });
  return { auth, ideaId: idea.id };
}

const ideaIds = async (auth: Parameters<typeof zettels.pageZettelCards>[0]) =>
  (await zettels.pageZettelCards(auth, { limit: 50, offset: 0 })).items.map((item) => item.id);
const galleryIds = async (auth: Parameters<typeof gallery.listGalleryArtifacts>[0]) =>
  (await gallery.listGalleryArtifacts(auth, { limit: 50 })).items.map((item) => item.id);

suite("artifact archive (delete with undo)", () => {
  it("archive hides the idea from Ideas and the gallery; restore brings the same row back", async () => {
    const { auth, ideaId } = await ideaIn("archive-roundtrip");
    expect(await ideaIds(auth)).toContain(ideaId);

    await archive.archiveArtifact(auth, { artifactId: ideaId });
    expect(await ideaIds(auth)).not.toContain(ideaId);
    expect(await galleryIds(auth)).not.toContain(ideaId);

    await archive.restoreArtifact(auth, { artifactId: ideaId });
    expect(await ideaIds(auth)).toContain(ideaId);
    expect(await galleryIds(auth)).toContain(ideaId);

    const actions = (
      await db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.subjectId, ideaId)))
    ).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["artifact.archived", "artifact.restored"]));
  });

  it("refuses a second archive and a restore of a live row", async () => {
    const { auth, ideaId } = await ideaIn("archive-twice");
    await expect(archive.restoreArtifact(auth, { artifactId: ideaId })).rejects.toThrow(/nothing to restore/);
    await archive.archiveArtifact(auth, { artifactId: ideaId });
    await expect(archive.archiveArtifact(auth, { artifactId: ideaId })).rejects.toThrow(/already gone/);
  });

  it("another workspace can neither archive nor restore the row", async () => {
    const { auth, ideaId } = await ideaIn("archive-tenant-a");
    const other = await seedWorkspace(db, `archive-tenant-b-${Date.now()}`);
    const intruder = ownerAuth(other.userId, other.workspaceId);
    await expect(archive.archiveArtifact(intruder, { artifactId: ideaId })).rejects.toThrow(/already gone/);
    expect(await ideaIds(auth)).toContain(ideaId);
    await archive.archiveArtifact(auth, { artifactId: ideaId });
    await expect(archive.restoreArtifact(intruder, { artifactId: ideaId })).rejects.toThrow(/nothing to restore/);
    expect(await ideaIds(auth)).not.toContain(ideaId);
  });
});
