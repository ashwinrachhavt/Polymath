import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { type TxDrizzle, withTransaction } from "@/lib/db-transaction";
import {
  documentExportManifestItems,
  documentExportManifests,
  documentExtractions,
  documents,
  files,
} from "./schema";

/*
 * Export manifests (ASH-130): "select exact document versions for a party or
 * purpose" - packet preparation-lite. A manifest is a named list; each item
 * pins the extraction version chosen when it was added, and the read side
 * reports drift ("a newer version exists") rather than silently upgrading.
 * Nothing here exports bytes yet; the manifest is the reviewed selection the
 * export step will honor exactly.
 */

export class ExportManifestError extends Error {
  constructor(
    readonly code: "not_found" | "stale_write" | "empty_selection",
    message: string,
  ) {
    super(message);
  }
}

type ExtractionRow = { id: string; contentHash: string; status: string; createdAt: Date };

/** The version an item pins: the document's latest succeeded extraction, or an honest null. */
export function pickPin(
  extractions: ExtractionRow[],
): { extractionId: string; extractionContentHash: string } | null {
  const succeeded = extractions
    .filter((e) => e.status === "succeeded")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest = succeeded[0];
  return latest ? { extractionId: latest.id, extractionContentHash: latest.contentHash } : null;
}

async function loadExtractions(documentIds: string[], executor: TxDrizzle | typeof db = db) {
  const byDocument = new Map<string, ExtractionRow[]>();
  if (documentIds.length === 0) return byDocument;
  const rows = await executor
    .select({
      documentId: documentExtractions.documentId,
      id: documentExtractions.id,
      contentHash: documentExtractions.contentHash,
      status: documentExtractions.status,
      createdAt: documentExtractions.createdAt,
    })
    .from(documentExtractions)
    .where(inArray(documentExtractions.documentId, documentIds));
  for (const row of rows) {
    const list = byDocument.get(row.documentId) ?? [];
    list.push(row);
    byDocument.set(row.documentId, list);
  }
  return byDocument;
}

export type ManifestItemInput = { documentId: string; note?: string | null };

export async function createExportManifest(
  auth: AuthContext,
  input: {
    name: string;
    purpose?: string | null;
    contactId?: string | null;
    companyId?: string | null;
    items: ManifestItemInput[];
  },
) {
  const name = input.name.trim();
  if (!input.items.length) throw new ExportManifestError("empty_selection", "A manifest needs at least one document.");
  return withTransaction(async (tx) => {
    const [manifest] = await tx
      .insert(documentExportManifests)
      .values({
        workspaceId: auth.workspaceId,
        name,
        purpose: input.purpose?.trim() || null,
        contactId: input.contactId ?? null,
        companyId: input.companyId ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await addItemsIn(tx, auth, manifest.id, input.items, 0);
    await recordAudit(
      auth,
      {
        action: "document_export.created",
        subjectType: "document_export_manifest",
        subjectId: manifest.id,
        summary: `Created export manifest "${name}" (${input.items.length} documents)`,
      },
      tx,
    );
    return manifest;
  });
}

/**
 * Insert items with their pins, failing the whole command on a foreign or
 * unknown document id - a manifest that quietly drops a document is a packet
 * the owner thinks is complete and is not.
 */
async function addItemsIn(
  tx: TxDrizzle,
  auth: AuthContext,
  manifestId: string,
  items: ManifestItemInput[],
  startPosition: number,
) {
  const documentIds = [...new Set(items.map((i) => i.documentId))];
  const owned = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, documentIds)));
  if (owned.length !== documentIds.length) {
    throw new ExportManifestError("not_found", "One or more documents are not in this workspace.");
  }
  const extractionsByDocument = await loadExtractions(documentIds, tx);
  // A document already in the manifest is a no-op, not a second row in the
  // packet; the unique key is the backstop, the dedupe keeps positions dense.
  await tx
    .insert(documentExportManifestItems)
    .values(
    items.map((item, index) => {
      const pin = pickPin(extractionsByDocument.get(item.documentId) ?? []);
      return {
        workspaceId: auth.workspaceId,
        manifestId,
        documentId: item.documentId,
        extractionId: pin?.extractionId ?? null,
        extractionContentHash: pin?.extractionContentHash ?? null,
        note: item.note?.trim() || null,
        position: startPosition + index,
        createdBy: auth.userId,
      };
    }),
    )
    .onConflictDoNothing();
}

export async function addExportItems(
  auth: AuthContext,
  input: { manifestId: string; expectedVersion: number; items: ManifestItemInput[] },
) {
  if (!input.items.length) throw new ExportManifestError("empty_selection", "Nothing to add.");
  return withTransaction(async (tx) => {
    const [manifest] = await tx
      .select()
      .from(documentExportManifests)
      .where(and(eq(documentExportManifests.id, input.manifestId), eq(documentExportManifests.workspaceId, auth.workspaceId), isNull(documentExportManifests.archivedAt)))
      .limit(1);
    if (!manifest) throw new ExportManifestError("not_found", "That manifest is not available.");
    if (manifest.version !== input.expectedVersion) {
      throw new ExportManifestError("stale_write", "That manifest changed. Reload to see the current state.");
    }
    const [last] = await tx
      .select({ position: documentExportManifestItems.position })
      .from(documentExportManifestItems)
      .where(eq(documentExportManifestItems.manifestId, manifest.id))
      .orderBy(desc(documentExportManifestItems.position))
      .limit(1);
    await addItemsIn(tx, auth, manifest.id, input.items, (last?.position ?? -1) + 1);
    const [row] = await tx
      .update(documentExportManifests)
      .set({ updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documentExportManifests.version} + 1` })
      .where(eq(documentExportManifests.id, manifest.id))
      .returning();
    return row;
  });
}

export async function removeExportItem(
  auth: AuthContext,
  input: { manifestId: string; itemId: string; expectedVersion: number },
) {
  return withTransaction(async (tx) => {
    const [manifest] = await tx
      .select()
      .from(documentExportManifests)
      .where(and(eq(documentExportManifests.id, input.manifestId), eq(documentExportManifests.workspaceId, auth.workspaceId), isNull(documentExportManifests.archivedAt)))
      .limit(1);
    if (!manifest) throw new ExportManifestError("not_found", "That manifest is not available.");
    if (manifest.version !== input.expectedVersion) {
      throw new ExportManifestError("stale_write", "That manifest changed. Reload to see the current state.");
    }
    const [removed] = await tx
      .delete(documentExportManifestItems)
      .where(and(eq(documentExportManifestItems.id, input.itemId), eq(documentExportManifestItems.manifestId, manifest.id)))
      .returning();
    if (!removed) throw new ExportManifestError("not_found", "That item is not in the manifest.");
    const [row] = await tx
      .update(documentExportManifests)
      .set({ updatedAt: new Date(), updatedBy: auth.userId, version: sql`${documentExportManifests.version} + 1` })
      .where(eq(documentExportManifests.id, manifest.id))
      .returning();
    return row;
  });
}

export async function listExportManifests(auth: AuthContext) {
  return db
    .select({
      id: documentExportManifests.id,
      name: documentExportManifests.name,
      purpose: documentExportManifests.purpose,
      contactId: documentExportManifests.contactId,
      companyId: documentExportManifests.companyId,
      itemCount: count(documentExportManifestItems.id),
      createdAt: documentExportManifests.createdAt,
      updatedAt: documentExportManifests.updatedAt,
      version: documentExportManifests.version,
    })
    .from(documentExportManifests)
    .leftJoin(documentExportManifestItems, eq(documentExportManifestItems.manifestId, documentExportManifests.id))
    .where(and(eq(documentExportManifests.workspaceId, auth.workspaceId), isNull(documentExportManifests.archivedAt)))
    .groupBy(documentExportManifests.id)
    .orderBy(desc(documentExportManifests.updatedAt));
}

export type ExportManifestItemView = {
  itemId: string;
  documentId: string;
  title: string;
  filename: string | null;
  note: string | null;
  position: number;
  /** The pinned version; null means "no succeeded extraction when pinned". */
  pinned: { extractionId: string | null; contentHash: string | null };
  /** The version the document would export today; differs after a re-extraction. */
  current: { extractionId: string; contentHash: string } | null;
  /** True when the pin is still the document's latest succeeded version. */
  isCurrent: boolean;
};

export async function getExportManifest(auth: AuthContext, input: { manifestId: string }) {
  const [manifest] = await db
    .select()
    .from(documentExportManifests)
    .where(and(eq(documentExportManifests.id, input.manifestId), eq(documentExportManifests.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!manifest) return null;

  const items = await db
    .select({
      itemId: documentExportManifestItems.id,
      documentId: documentExportManifestItems.documentId,
      extractionId: documentExportManifestItems.extractionId,
      extractionContentHash: documentExportManifestItems.extractionContentHash,
      note: documentExportManifestItems.note,
      position: documentExportManifestItems.position,
      title: documents.title,
      filename: files.filename,
    })
    .from(documentExportManifestItems)
    .innerJoin(documents, eq(documents.id, documentExportManifestItems.documentId))
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(eq(documentExportManifestItems.manifestId, manifest.id))
    .orderBy(asc(documentExportManifestItems.position), asc(documentExportManifestItems.createdAt));

  const extractionsByDocument = await loadExtractions(items.map((i) => i.documentId));

  const views: ExportManifestItemView[] = items.map((item) => {
    const current = pickPin(extractionsByDocument.get(item.documentId) ?? []);
    const isCurrent = current !== null && current.extractionContentHash === item.extractionContentHash;
    return {
      itemId: item.itemId,
      documentId: item.documentId,
      title: item.title,
      filename: item.filename,
      note: item.note,
      position: item.position,
      pinned: { extractionId: item.extractionId, contentHash: item.extractionContentHash },
      current: current ? { extractionId: current.extractionId, contentHash: current.extractionContentHash } : null,
      isCurrent,
    };
  });

  return { ...manifest, items: views };
}
