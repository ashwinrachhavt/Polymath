import { and, eq, isNull, sql } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { sha256Hex } from "@/lib/hash";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, validateFile } from "@/lib/file-validation";
import { ObjectStoreUnconfiguredError } from "@/integrations/object-store/object-store";
import {
  claimStartReceipt,
  completeStartReceipt,
  freeStartReceipt,
  type StartReceiptClaim,
} from "@/domains/audit/receipt";
import { extractDocument } from "@/domains/knowledge/extraction";
import { intakeFile } from "@/domains/knowledge/intake";
import { resolveFolderPath } from "@/domains/knowledge/folder-paths";
import { FolderError } from "@/domains/knowledge/folders";
import { documentFolders, documents } from "@/domains/knowledge/schema";
import { currentExtractionSql } from "@/domains/knowledge/versions";

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
  /** The folder the owner is uploading into; absent means the library root. */
  folderId: z.string().uuid().optional(),
  /** Relative folder path from the upload; subdirectories are created below folderId. */
  folderPath: z.string().max(1000).optional(),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return problemResponse(415, "unsupported_media_type", "Upload as multipart/form-data.");
  }

  const form = await request.formData();
  const file = form.get("file");
  const parsedTitle = documentMeta.safeParse({
    title: form.get("title"),
    folderId: form.get("folderId") ?? undefined,
    folderPath: form.get("folderPath") ?? undefined,
  });
  if (!(file instanceof File)) {
    return problemResponse(400, "invalid_request", "Attach a file in the 'file' field.");
  }
  if (!parsedTitle.success) {
    return problemResponse(400, "invalid_request", "Give the document a title.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return problemResponse(413, "payload_too_large", `Files are limited to ${MAX_UPLOAD_LABEL}.`);
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = validateFile(bytes, file.name);

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
    ? await sha256Hex(`${contentHex}:${parsedTitle.data.title}`)
    : null;

  // Claim before any work: the claim is insert-or-lose on the receipt unique
  // index, so two concurrent first attempts cannot both write a blob and both
  // race into finalize — the loser of the claim replays or waits instead of
  // dying on the index as an unhandled 500.
  let claim: StartReceiptClaim | null = null;
  if (idempotencyKey && requestHash) {
    claim = await claimStartReceipt(auth, idempotencyKey, requestHash);
    if (!claim.claimed) {
      if (claim.kind === "conflict") {
        return problemResponse(422, "idempotency_conflict", "This key was used for a different request.");
      }
      if (claim.kind === "in_progress") {
        return problemResponse(409, "request_in_progress", "This upload is still being processed. Retry in a moment.");
      }
      return Response.json(claim.response, { status: 201 });
    }
  }
  // A claim is only held while this attempt owns the key: every early return
  // after the claim frees it, so a deterministic failure (bad folder) or a
  // crashed finalize leaves the key retryable.
  const freeClaim = async () => {
    if (idempotencyKey) await freeStartReceipt(auth, idempotencyKey);
  };

  // The owner is standing in a folder: uploads file there. A dropped
  // directory keeps its relative structure underneath it. Verify the folder
  // before creating anything, so a stale tab cannot file into a foreign or
  // archived folder.
  const baseFolderId = parsedTitle.data.folderId ?? null;
  if (baseFolderId) {
    const [folder] = await db
      .select({ id: documentFolders.id })
      .from(documentFolders)
      .where(
        and(
          eq(documentFolders.id, baseFolderId),
          eq(documentFolders.workspaceId, auth.workspaceId),
          isNull(documentFolders.archivedAt),
        ),
      )
      .limit(1);
    if (!folder) {
      await freeClaim();
      return problemResponse(404, "not_found", "That folder is not available.");
    }
  }

  let targetFolderId = baseFolderId;
  if (parsedTitle.data.folderPath) {
    try {
      targetFolderId = (
        await resolveFolderPath(auth, parsedTitle.data.folderPath, { parentId: baseFolderId })
      ).folderId;
    } catch (error) {
      // A dropped directory can carry a segment the folder rules reject (too
      // long, empty after trimming). That is the upload's fault, not a server
      // fault, so the client gets a readable 400 instead of a 500.
      if (error instanceof FolderError) {
        await freeClaim();
        return problemResponse(400, "invalid_folder", error.message);
      }
      throw error;
    }
  }

  let result: Awaited<ReturnType<typeof intakeFile>>;
  try {
    result = await intakeFile(auth, {
      bytes,
      filename: file.name,
      title: parsedTitle.data.title,
      folderId: targetFolderId,
      verdict,
      contentHash: contentHex,
      origin: "upload",
      // Completion in the same transaction as finalize, for quarantine too:
      // the receipt's response commits atomically with the document row it
      // names, so a replay can never answer for work that rolled back. The
      // retry path most likely to be exercised (re-POST after fixing
      // something) must not mint a second blob + file row for the same key.
      inTransaction: async (tx, rows) => {
        if (!idempotencyKey) return;
        await completeStartReceipt(
          tx,
          auth,
          idempotencyKey,
          rows.documentId ? 201 : 200,
          rows.documentId
            ? { documentId: rows.documentId, contentHash: contentHex }
            : { fileId: rows.fileId, fileStatus: "quarantined" },
        );
      },
    });
  } catch (error) {
    await freeClaim();
    if (error instanceof ObjectStoreUnconfiguredError) {
      return problemResponse(503, "storage_unconfigured", error.message);
    }
    throw error;
  }

  if (!result.documentId) {
    return Response.json(
      { fileId: result.fileId, fileStatus: "quarantined" },
      { status: 200 },
    );
  }

  // The response does not wait on AI enrichment: extraction runs after the
  // 201 (the platform keeps the function alive for `after` work), so the row
  // moves Added -> Reading -> its outcome on its own. A throw here is already
  // recorded on the durable extraction row by extractDocument's own failure
  // path; swallow it so the log stays an observation, not an error storm.
  const documentId = result.documentId;
  const work = async () => {
    try {
      await extractDocument(auth, { documentId });
    } catch {
      // The extraction row carries the failure; the inbox offers a retry.
    }
  };
  try {
    after(work);
  } catch {
    // Outside a request scope (a direct handler call, as in tests) `after`
    // throws; run the same work fire-and-forget instead.
    void work();
  }

  return Response.json(
    { documentId: result.documentId, contentHash: result.contentHash },
    { status: 201 },
  );
});

export const GET = authedHandler(async (auth, request) => {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  if (!documentId) return problemResponse(400, "invalid_request", "Pass a documentId.");

  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      mimeType: documents.mimeType,
      // The upload UI polls this to show reading progress rather than guessing
      // how long Docling takes.
      extractionStatus: sql<string | null>`${currentExtractionSql("status")}`,
      extractionError: sql<string | null>`(select de.error from document_extractions de where de.document_id = ${documents.id} order by de.created_at desc limit 1)`,
    })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return problemResponse(404, "not_found", "No such document in this workspace.");
  return Response.json(doc);
});
