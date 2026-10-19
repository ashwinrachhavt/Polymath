import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { blobObjects } from "@/domains/audit/schema";
import { documentExtractions, documents, files } from "@/domains/knowledge/schema";
import { sha256Hex } from "@/lib/hash";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Packet assembly against real Postgres plus the local object store
 * (ASH-130 full packets): the zip ships exactly the pinned bytes, drift is
 * flagged not substituted, hash-mismatched storage ships nothing, and
 * assembly refuses foreign manifests and stale manifest versions. Local blob
 * keys only work outside production, which is where tests run.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: NonNullable<ReturnType<typeof makeTestDb>>["db"] } = { db: undefined as never };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

let packets: typeof import("@/domains/knowledge/packets");
let exports_: typeof import("@/domains/knowledge/exports");
let objectStore: typeof import("@/integrations/object-store/object-store");

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  process.env.AXIOM_LOCAL_BLOB_DIR = `/tmp/axiom-blob-test-${process.pid}`;
  packets = await import("@/domains/knowledge/packets");
  exports_ = await import("@/domains/knowledge/exports");
  objectStore = await import("@/integrations/object-store/object-store");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("export packets", () => {
  type Auth = { userId: string; workspaceId: string; role: "owner" };

  async function seedDocumentWithBytes(auth: Auth, title: string, filename: string, bytes: Uint8Array, extractionStatus: "succeeded" | "failed" = "succeeded") {
    const stored = await objectStore.putBlob({ bytes, filename, contentType: "application/pdf", workspaceId: auth.workspaceId });
    const [blob] = await holder.db
      .insert(blobObjects)
      .values({ workspaceId: auth.workspaceId, storageKey: stored.storageKey, contentHash: stored.contentHash, sizeBytes: stored.sizeBytes, mimeType: "application/pdf" })
      .returning();
    const [file] = await holder.db.insert(files).values({ workspaceId: auth.workspaceId, blobId: blob.id, filename }).returning();
    const [document] = await holder.db.insert(documents).values({ workspaceId: auth.workspaceId, title, fileId: file.id }).returning();
    let extractionId: string | null = null;
    if (extractionStatus === "succeeded") {
      const [extraction] = await holder.db
        .insert(documentExtractions)
        .values({ workspaceId: auth.workspaceId, documentId: document.id, contentHash: stored.contentHash, status: "succeeded", text: "read" })
        .returning();
      extractionId = extraction.id;
    }
    return { document, contentHash: stored.contentHash, extractionId };
  }

  it("assembly ships pinned bytes, flags drift, reports the missing honestly", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db, `packets-${Date.now()}`);
    const auth: Auth = { userId, workspaceId, role: "owner" };

    const a = await seedDocumentWithBytes(auth, "Lease Agreement", "lease.pdf", new TextEncoder().encode("lease bytes one"));
    const b = await seedDocumentWithBytes(auth, "Bank Statement", "statement.pdf", new TextEncoder().encode("statement bytes two"));
    const unread = await seedDocumentWithBytes(auth, "Scanned Receipt", "receipt.pdf", new TextEncoder().encode("receipt bytes"), "failed");

    const manifest = await exports_.createExportManifest(auth, {
      name: "Housing packet",
      purpose: "Application",
      items: [{ documentId: a.document.id }, { documentId: b.document.id }, { documentId: unread.document.id }],
    });

    // Drift b: a newer succeeded extraction of different bytes... its blob
    // stays the original pinned one, so the packet ships the pinned version.
    await holder.db.insert(documentExtractions).values({
      workspaceId,
      documentId: b.document.id,
      contentHash: `ch-${crypto.randomUUID()}`,
      status: "succeeded",
      text: "amended",
      createdAt: new Date(Date.now() + 60_000),
    });

    const assembled = await packets.assembleExportPacket(auth, { manifestId: manifest.id });
    expect(assembled.itemCount).toBe(2);
    expect(assembled.missingCount).toBe(1);
    expect(assembled.driftedCount).toBe(1);

    // The stored blob is exactly what the row says, and the zip carries the
    // pinned bytes plus a manifest that names the drifted and the missing.
    const packet = await packets.getExportPacketBlob(auth, { packetId: assembled.packetId });
    expect(packet).toBeTruthy();
    const zip = await objectStore.readBlob(packet!.storageKey);
    expect(await sha256Hex(zip)).toBe(assembled.contentHash);
    const text = Buffer.from(zip).toString("latin1");
    expect(text).toContain("lease bytes one");
    expect(text).toContain("statement bytes two");
    expect(text).not.toContain("receipt bytes");
    const manifestStart = text.indexOf('{\n  "name"');
    const manifestJson = JSON.parse(text.slice(manifestStart, text.indexOf("\n}", manifestStart) + 2));
    expect(manifestJson.name).toBe("Housing packet");
    expect(manifestJson.items.find((i: { title: string }) => i.title === "Bank Statement")?.drifted).toBe(true);
    expect(manifestJson.items.find((i: { title: string }) => i.title === "Lease Agreement")?.drifted).toBe(false);
    expect(manifestJson.missing[0].title).toBe("Scanned Receipt");

    // Entry names are ordered, titled, and hash-stamped.
    expect(text).toContain(`01 - Lease Agreement - ${a.contentHash.slice(0, 8)}.pdf`);

    // listExportPackets sees it.
    const listed = await packets.listExportPackets(auth, { manifestId: manifest.id });
    expect(listed).toHaveLength(1);
    expect(listed[0].packetId).toBe(assembled.packetId);

    // Stale manifest version is refused; foreign manifest and packet are 404s.
    await expect(packets.assembleExportPacket(auth, { manifestId: manifest.id, expectedManifestVersion: 99 })).rejects.toMatchObject({ code: "stale_write" });
    const other = await seedWorkspace(holder.db, `packets-other-${Date.now()}`);
    const otherAuth: Auth = { userId: other.userId, workspaceId: other.workspaceId, role: "owner" };
    await expect(packets.assembleExportPacket(otherAuth, { manifestId: manifest.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await packets.getExportPacketBlob(otherAuth, { packetId: assembled.packetId })).toBeNull();

    // A document whose stored bytes no longer match the pin ships nothing.
    const c = await seedDocumentWithBytes(auth, "Swapped", "swapped.pdf", new TextEncoder().encode("swapped bytes"));
    await holder.db
      .update(documentExtractions)
      .set({ contentHash: `ch-pinned-${crypto.randomUUID()}` })
      .where(eq(documentExtractions.id, c.extractionId!));
    const [pinned] = await holder.db.select({ contentHash: documentExtractions.contentHash }).from(documentExtractions).where(eq(documentExtractions.id, c.extractionId!));
    const manifest2 = await exports_.createExportManifest(auth, { name: "Second", items: [{ documentId: c.document.id }] });
    await holder.db.execute(
      // force the manifest pin to the tampered hash, as if bytes were swapped after pinning
      (await import("drizzle-orm")).sql`update document_export_manifest_items set extraction_content_hash = ${pinned!.contentHash} where manifest_id = ${manifest2.id}`,
    );
    const second = await packets.assembleExportPacket(auth, { manifestId: manifest2.id });
    expect(second.itemCount).toBe(0);
    expect(second.missingCount).toBe(1);
  });
});
