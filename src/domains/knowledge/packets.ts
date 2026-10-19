import { and, asc, desc, eq } from "drizzle-orm";
import { blobObjects } from "@/domains/audit/schema";
import { recordAudit } from "@/domains/audit/record";
import { putBlob, readBlob } from "@/integrations/object-store/object-store";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { buildZip, type ZipEntry } from "@/lib/zip";
import type { AuthContext } from "@/domains/identity/resolve";
import { pickPin } from "./exports";
import {
  documentExportManifestItems,
  documentExportManifests,
  documentExportPackets,
  documentExtractions,
  documents,
  files,
} from "./schema";

/*
 * Packet assembly (ASH-130 full packets, ASH-108 §10): turn a manifest into
 * an immutable, downloadable zip of the exact pinned versions. A packet is a
 * derived artifact - it never touches the manifest or the documents, and a
 * later manifest edit does not mutate packets already assembled. Honesty
 * rules:
 * - An item whose document bytes no longer match the pinned hash ships
 *   nothing: the packet contains the pinned version or says why it cannot.
 * - An item whose pin drifted (re-extracted or restored elsewhere) still
 *   ships its pinned bytes, flagged in the enclosed manifest.
 * - Items pinned as honest nulls (no succeeded extraction) and documents
 *   without stored bytes are listed under `missing`, never silently dropped.
 */

export class ExportPacketError extends Error {
  constructor(
    public readonly code: "not_found" | "stale_write",
    message: string,
  ) {
    super(message);
    this.name = "ExportPacketError";
  }
}

/** The filename a packet entry gets: ordered, titled, hash-stamped, extension kept. */
export function packetEntryName(position: number, title: string, contentHash: string, originalFilename: string | null): string {
  const ext = originalFilename?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ".bin";
  const base = title
    .replace(/[\\/:*?"<>\u0000-\u001f|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stamp = contentHash.slice(0, 8);
  return `${String(position + 1).padStart(2, "0")} - ${base || "document"} - ${stamp}${ext}`;
}

export type AssembledPacket = {
  packetId: string;
  manifestVersion: number;
  itemCount: number;
  missingCount: number;
  driftedCount: number;
  sizeBytes: number;
  contentHash: string;
};

export async function assembleExportPacket(
  auth: AuthContext,
  input: { manifestId: string; expectedManifestVersion?: number },
): Promise<AssembledPacket> {
  const [manifest] = await db
    .select()
    .from(documentExportManifests)
    .where(and(eq(documentExportManifests.id, input.manifestId), eq(documentExportManifests.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!manifest) throw new ExportPacketError("not_found", "No such export manifest in this workspace.");
  if (input.expectedManifestVersion !== undefined && manifest.version !== input.expectedManifestVersion) {
    throw new ExportPacketError("stale_write", "That manifest changed. Reload to see the current state.");
  }

  const items = await db
    .select({
      position: documentExportManifestItems.position,
      note: documentExportManifestItems.note,
      pinnedExtractionId: documentExportManifestItems.extractionId,
      pinnedContentHash: documentExportManifestItems.extractionContentHash,
      title: documents.title,
      filename: files.filename,
      documentId: documents.id,
      storageKey: blobObjects.storageKey,
    })
    .from(documentExportManifestItems)
    .innerJoin(documents, eq(documents.id, documentExportManifestItems.documentId))
    .leftJoin(files, eq(files.id, documents.fileId))
    .leftJoin(blobObjects, eq(blobObjects.id, files.blobId))
    .where(eq(documentExportManifestItems.manifestId, manifest.id))
    .orderBy(asc(documentExportManifestItems.position), asc(documentExportManifestItems.createdAt));

  // Drift is judged against what the document reads as today (restore-aware).
  const extractionRows = await db
    .select({
      documentId: documentExtractions.documentId,
      id: documentExtractions.id,
      contentHash: documentExtractions.contentHash,
      status: documentExtractions.status,
      createdAt: documentExtractions.createdAt,
    })
    .from(documentExtractions)
    .where(eq(documentExtractions.workspaceId, auth.workspaceId));
  const docRows = await db
    .select({ id: documents.id, activeExtractionId: documents.activeExtractionId })
    .from(documents)
    .where(eq(documents.workspaceId, auth.workspaceId));
  const pins = new Map(docRows.map((d) => [d.id, d.activeExtractionId]));
  const byDocument = new Map<string, typeof extractionRows>();
  for (const row of extractionRows) {
    const list = byDocument.get(row.documentId) ?? [];
    list.push(row);
    byDocument.set(row.documentId, list);
  }

  const entries: ZipEntry[] = [];
  const manifestItems: Array<Record<string, unknown>> = [];
  const missing: Array<Record<string, unknown>> = [];
  let driftedCount = 0;

  for (const item of items) {
    const current = pickPin(byDocument.get(item.documentId) ?? [], pins.get(item.documentId));
    const drifted = current !== null && item.pinnedContentHash !== null && current.extractionContentHash !== item.pinnedContentHash;
    if (drifted) driftedCount += 1;

    if (!item.pinnedContentHash) {
      missing.push({ position: item.position, title: item.title, reason: "no_succeeded_extraction" });
      continue;
    }
    if (!item.storageKey) {
      missing.push({ position: item.position, title: item.title, reason: "no_stored_bytes" });
      continue;
    }
    const bytes = await readBlob(item.storageKey);
    if ((await sha256Hex(bytes)) !== item.pinnedContentHash) {
      // The stored bytes are not the pinned version; ship nothing rather than
      // silently substitute.
      missing.push({ position: item.position, title: item.title, reason: "bytes_no_longer_match_pin" });
      continue;
    }
    const exportedAs = packetEntryName(item.position, item.title, item.pinnedContentHash, item.filename);
    entries.push({ name: exportedAs, bytes });
    manifestItems.push({
      position: item.position,
      title: item.title,
      exportedAs,
      pinnedExtractionId: item.pinnedExtractionId,
      contentHash: item.pinnedContentHash,
      note: item.note,
      drifted,
    });
  }

  const envelope = {
    name: manifest.name,
    purpose: manifest.purpose,
    recipient: { contactId: manifest.contactId, companyId: manifest.companyId },
    manifestVersion: manifest.version,
    assembledAt: new Date().toISOString(),
    items: manifestItems,
    missing,
  };
  entries.push({ name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify(envelope, null, 2)) });

  const zip = buildZip(entries);
  const contentHash = await sha256Hex(zip);
  const safeName = manifest.name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "packet";
  const stored = await putBlob({
    bytes: zip,
    filename: `${safeName}.zip`,
    contentType: "application/zip",
    workspaceId: auth.workspaceId,
    contentHash,
  });

  return withTransaction(async (tx) => {
    const [blob] = await tx
      .insert(blobObjects)
      .values({
        workspaceId: auth.workspaceId,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
        mimeType: "application/zip",
        retentionClass: "standard",
        createdBy: auth.userId,
      })
      .returning({ id: blobObjects.id });
    const [packet] = await tx
      .insert(documentExportPackets)
      .values({
        workspaceId: auth.workspaceId,
        manifestId: manifest.id,
        manifestVersion: manifest.version,
        blobId: blob!.id,
        itemCount: entries.length - 1,
        missingCount: missing.length,
        driftedCount,
        sizeBytes: stored.sizeBytes,
        contentHash,
        createdBy: auth.userId,
      })
      .returning({ id: documentExportPackets.id });
    await recordAudit(
      auth,
      {
        action: "document.export_packet_assembled",
        subjectType: "document_export_manifest",
        subjectId: manifest.id,
        summary: `Assembled packet: ${entries.length - 1} document(s), ${missing.length} missing, ${driftedCount} drifted`,
        metadata: { packetId: packet!.id, manifestVersion: manifest.version, contentHash },
      },
      tx,
    );
    return {
      packetId: packet!.id,
      manifestVersion: manifest.version,
      itemCount: entries.length - 1,
      missingCount: missing.length,
      driftedCount,
      sizeBytes: stored.sizeBytes,
      contentHash,
    };
  });
}

/** Packets assembled from one manifest, newest first. */
export async function listExportPackets(auth: AuthContext, input: { manifestId: string }) {
  return db
    .select({
      packetId: documentExportPackets.id,
      manifestVersion: documentExportPackets.manifestVersion,
      itemCount: documentExportPackets.itemCount,
      missingCount: documentExportPackets.missingCount,
      driftedCount: documentExportPackets.driftedCount,
      sizeBytes: documentExportPackets.sizeBytes,
      contentHash: documentExportPackets.contentHash,
      createdAt: documentExportPackets.createdAt,
    })
    .from(documentExportPackets)
    .where(and(eq(documentExportPackets.manifestId, input.manifestId), eq(documentExportPackets.workspaceId, auth.workspaceId)))
    .orderBy(desc(documentExportPackets.createdAt))
    .limit(50);
}

/** One packet's downloadable blob, workspace-scoped, or null. */
export async function getExportPacketBlob(auth: AuthContext, input: { packetId: string }) {
  const [row] = await db
    .select({
      packetId: documentExportPackets.id,
      storageKey: blobObjects.storageKey,
      sizeBytes: documentExportPackets.sizeBytes,
      contentHash: documentExportPackets.contentHash,
      manifestName: documentExportManifests.name,
    })
    .from(documentExportPackets)
    .innerJoin(blobObjects, eq(blobObjects.id, documentExportPackets.blobId))
    .innerJoin(documentExportManifests, eq(documentExportManifests.id, documentExportPackets.manifestId))
    .where(and(eq(documentExportPackets.id, input.packetId), eq(documentExportPackets.workspaceId, auth.workspaceId)))
    .limit(1);
  return row ?? null;
}
