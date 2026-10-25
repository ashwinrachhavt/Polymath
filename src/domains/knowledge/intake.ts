import { and, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { putBlob } from "@/integrations/object-store/object-store";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import type { FileValidationResult } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";
import { auditEvents, blobObjects, outboxEvents } from "../audit/schema";
import { documents, files } from "./schema";

/*
 * The one place bytes become a file and a document. The upload route and URL
 * capture both come through here, so there is a single ingest path: store the
 * blob, record blob_objects + files, create or attach the document, queue
 * extraction, write the audit row. The route's idempotency receipt rides in the
 * same transaction through `inTransaction`.
 */

export type IntakeInput = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  /** From validateFile. A failed verdict quarantines the original and creates no document. */
  verdict: FileValidationResult;
  /** sha256 hex of the bytes when the caller already has it. */
  contentHash?: string;
  origin: "upload" | "url" | "crawl" | "youtube" | "capture";
  /** Captured documents carry where they came from. */
  sourceUrl?: string;
  /** Folder the document files into; null (the default) is the library root. */
  folderId?: string | null;
  /** Attach the file to this existing document row (a URL document whose first fetch failed) instead of inserting one. */
  documentId?: string;
  /** Runs inside the same transaction, after the rows exist. */
  inTransaction?: (tx: TxDrizzle, rows: { documentId: string | null; fileId: string }) => Promise<void>;
};

export type IntakeResult = { documentId: string | null; fileId: string; contentHash: string };

/** Another caller attached bytes to this document first; the loser's rows roll back. */
export class DocumentAlreadyHasFileError extends Error {
  constructor() {
    super("document already has a file");
    this.name = "DocumentAlreadyHasFileError";
  }
}

export async function intakeFile(auth: AuthContext, input: IntakeInput): Promise<IntakeResult> {
  const contentHash = input.contentHash ?? (await sha256Hex(input.bytes));
  const mimeType = input.verdict.ok ? input.verdict.mimeType : "application/octet-stream";
  const stored = await putBlob({
    bytes: input.bytes,
    filename: input.filename,
    contentType: mimeType,
    workspaceId: auth.workspaceId,
    contentHash,
  });

  const result = await withTransaction(async (tx) => {
    // Two intakes of the same content race on the storage-key unique index.
    // ON CONFLICT makes the loser wait for the winner's commit and join its
    // blob row; the document attach below then throws
    // DocumentAlreadyHasFileError and the loser's file row rolls back.
    const blob =
      (await tx
        .insert(blobObjects)
        .values({
          workspaceId: auth.workspaceId,
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
          mimeType,
          retentionClass: "standard",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing({ target: blobObjects.storageKey })
        .returning({ id: blobObjects.id }))[0] ??
      (
        await tx
          .select({ id: blobObjects.id })
          .from(blobObjects)
          .where(eq(blobObjects.storageKey, stored.storageKey))
          .limit(1)
      )[0];

    const [fileRow] = await tx
      .insert(files)
      .values({
        workspaceId: auth.workspaceId,
        blobId: blob.id,
        filename: input.filename,
        // Content wins: an allowlist mismatch keeps the original but marks it
        // for manual review instead of minting a document from it.
        status: input.verdict.ok ? "uploaded" : "quarantined",
        origin: input.origin,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: files.id });

    let documentId: string | null = null;
    if (input.verdict.ok) {
      if (input.documentId) {
        const [attached] = await tx
          .update(documents)
          .set({ fileId: fileRow.id, mimeType, title: input.title, updatedBy: auth.userId, updatedAt: new Date() })
          .where(and(
            eq(documents.id, input.documentId),
            eq(documents.workspaceId, auth.workspaceId),
            isNull(documents.fileId),
          ))
          .returning({ id: documents.id });
        if (!attached) throw new DocumentAlreadyHasFileError();
        documentId = attached.id;
      } else {
        const [doc] = await tx
          .insert(documents)
          .values({
            workspaceId: auth.workspaceId,
            fileId: fileRow.id,
            title: input.title,
            mimeType,
            sourceUrl: input.sourceUrl,
            folderId: input.folderId ?? null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning({ id: documents.id });
        documentId = doc.id;
      }

      // Intake succeeds independently of AI enrichment; a consumer picks this
      // up and runs extraction. Nothing here calls a model.
      await tx.insert(outboxEvents).values({
        workspaceId: auth.workspaceId,
        topic: "document.extraction_requested",
        payload: { documentId },
      });
    }

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: input.verdict.ok
        ? input.origin === "url" || input.origin === "capture" ? "file.captured"
          : input.origin === "crawl" ? "file.crawled"
            : input.origin === "youtube" ? "file.transcribed"
              : "file.uploaded"
        : "file.quarantined",
      subjectType: input.verdict.ok ? "document" : "file",
      subjectId: input.verdict.ok ? documentId : fileRow.id,
      summary: input.verdict.ok
        ? input.origin === "url" || input.origin === "capture"
          ? `Captured ${input.sourceUrl ?? input.filename}`
          : input.origin === "crawl"
            ? `Crawled ${input.sourceUrl ?? input.filename}`
            : input.origin === "youtube"
              ? `Transcribed ${input.sourceUrl ?? input.filename}`
              : `Uploaded ${input.filename}`
        : `Quarantined ${input.filename}: content did not match the allowlist`,
    });

    await input.inTransaction?.(tx, { documentId, fileId: fileRow.id });
    return { documentId, fileId: fileRow.id };
  });

  return { ...result, contentHash: stored.contentHash };
}
