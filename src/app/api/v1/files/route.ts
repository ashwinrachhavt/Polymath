import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { sha256Hex } from "@/lib/hash";
import { MAX_UPLOAD_BYTES, validateFile } from "@/lib/file-validation";
import { ObjectStoreUnconfiguredError, putBlob } from "@/integrations/object-store/object-store";
import { auditEvents, blobObjects, outboxEvents, requestReceipts } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";

/*
 * POST /api/v1/files — upload a document, store the binary in Vercel Blob,
 * record blob_objects + files + documents, and return the document id for the
 * later extraction call. 4.5 MB function body limit is the Vercel ceiling;
 * larger files use the client-upload path when it lands.
 *
 * Type is decided by content sniffing, never the client's claims: a mismatch
 * with the allowlist quarantines the original rather than losing it (a
 * preserved original beats a 415 the owner cannot retry). Idempotency-Key
 * replays return the stored response from request_receipts instead of
 * creating a duplicate, and finalize writes the extraction outbox row so
 * upload never waits on AI enrichment.
 */

const documentMeta = z.object({
  title: z.string().min(1).max(500),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return problemResponse(415, "unsupported_media_type", "Upload as multipart/form-data.");
  }

  const form = await request.formData();
  const file = form.get("file");
  const parsedTitle = documentMeta.shape.title.safeParse(form.get("title"));
  if (!(file instanceof File)) {
    return problemResponse(400, "invalid_request", "Attach a file in the 'file' field.");
  }
  if (!parsedTitle.success) {
    return problemResponse(400, "invalid_request", "Give the document a title.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return problemResponse(413, "payload_too_large", "Files are limited to 4 MB.");
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = validateFile(bytes);

  // Truly unreadable: empty. A sniff mismatch is not unreadable — it gets
  // quarantined below, not rejected here. (Oversize already returned above.)
  if (!verdict.ok && verdict.reason === "empty_file") {
    return problemResponse(400, "empty_file", "The uploaded file is empty.");
  }

  // Key the receipt on what the request actually carried: content, title.
  // Name and claimed type are excluded — a retry with a corrected filename is
  // the same upload, a different title is not. One digest serves both this
  // receipt hash and the blob row via putBlob's contentHash passthrough.
  const contentHex = await sha256Hex(bytes);
  const requestHash = idempotencyKey
    ? await sha256Hex(`${contentHex}:${parsedTitle.data}`)
    : null;

  // Replay check before any blob write: the stored response is the document id
  // from the first attempt, so a retry cannot duplicate the document.
  if (idempotencyKey) {
    const [receipt] = await db
      .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
      .from(requestReceipts)
      .where(
        and(
          eq(requestReceipts.workspaceId, auth.workspaceId),
          eq(requestReceipts.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        return problemResponse(
          422,
          "idempotency_conflict",
          "This key was used for a different request.",
        );
      }
      return Response.json(receipt.response, { status: 201 });
    }
  }

  let stored: Awaited<ReturnType<typeof putBlob>>;
  try {
    stored = await putBlob({
      bytes,
      filename: file.name,
      contentType: verdict.ok ? verdict.mimeType : "application/octet-stream",
      workspaceId: auth.workspaceId,
      contentHash: contentHex,
    });
  } catch (error) {
    if (error instanceof ObjectStoreUnconfiguredError) {
      return problemResponse(503, "storage_unconfigured", error.message);
    }
    throw error;
  }

  // ponytail: a replay racing the first finalize hits the unique index and
  // surfaces as a 500; queue-front retries go through the receipt read above.
  const result = await withTransaction(async (tx) => {
    const [blob] = await tx
      .insert(blobObjects)
      .values({
        workspaceId: auth.workspaceId,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
        mimeType: verdict.ok ? verdict.mimeType : "application/octet-stream",
        retentionClass: "standard",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: blobObjects.id });

    const [fileRow] = await tx
      .insert(files)
      .values({
        workspaceId: auth.workspaceId,
        blobId: blob.id,
        filename: file.name,
        // Content wins: an allowlist mismatch keeps the original but marks it
        // for manual review instead of minting a document from it.
        status: verdict.ok ? "uploaded" : "quarantined",
        origin: "upload",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: files.id });

    let documentId: string | null = null;
    if (verdict.ok) {
      const [doc] = await tx
        .insert(documents)
        .values({
          workspaceId: auth.workspaceId,
          fileId: fileRow.id,
          title: parsedTitle.data,
          mimeType: verdict.mimeType,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: documents.id });
      documentId = doc.id;

      // Upload succeeds independently of AI enrichment; a consumer picks this
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
      action: verdict.ok ? "file.uploaded" : "file.quarantined",
      subjectType: verdict.ok ? "document" : "file",
      subjectId: verdict.ok ? documentId : fileRow.id,
      summary: verdict.ok
        ? `Uploaded ${file.name}`
        : `Quarantined ${file.name}: content did not match the allowlist`,
    });

    // Receipt in the same transaction as finalize — for quarantine too: the
    // retry path most likely to be exercised (re-POST after fixing something)
    // must not mint a second blob + file row for the same key.
    if (idempotencyKey) {
      await tx.insert(requestReceipts).values({
        workspaceId: auth.workspaceId,
        idempotencyKey,
        requestHash: requestHash!,
        statusCode: documentId ? 201 : 200,
        response: documentId
          ? { documentId, contentHash: stored.contentHash }
          : { fileId: fileRow.id, fileStatus: "quarantined" },
      });
    }

    return { documentId, fileId: fileRow.id };
  });

  if (!result.documentId) {
    return Response.json(
      { fileId: result.fileId, fileStatus: "quarantined" },
      { status: 200 },
    );
  }

  return Response.json(
    { documentId: result.documentId, contentHash: stored.contentHash },
    { status: 201 },
  );
});

export const GET = authedHandler(async (auth, request) => {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  if (!documentId) return problemResponse(400, "invalid_request", "Pass a documentId.");

  const [doc] = await db
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return problemResponse(404, "not_found", "No such document in this workspace.");
  return Response.json(doc);
});
