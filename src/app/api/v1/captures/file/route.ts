import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { sha256Hex } from "@/lib/hash";
import { validateFile, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/file-validation";
import { ObjectStoreUnconfiguredError } from "@/integrations/object-store/object-store";
import { requestReceipts } from "@/domains/audit/schema";
import { IdempotencyConflictError, receiptRequestHash } from "@/domains/audit/receipt";
import { ConflictError, createFileCapture, fileCaptureReceiptRequest, StorageWriteFailedError } from "@/domains/capture/commands";

/*
 * The deploy-supported ceiling: 4 MB, the same one every intake path shares.
 * Vercel caps a serverless request body at 4.5 MB including multipart
 * overhead, so a larger promise would fail at the platform with a bare 413
 * before this code runs. Raising it means the client-upload path (direct to
 * Blob, then finalize) - separate work, same as documents.
 */
export const MAX_CAPTURE_UPLOAD_BYTES = MAX_UPLOAD_BYTES;

/*
 * POST /api/v1/captures/file - upload a file or screenshot straight into the
 * inbox. Same contract as document upload: content sniffing decides the type
 * (the client's filename and content-type are never trusted), a mismatch
 * quarantines the original instead of rejecting it, and an Idempotency-Key
 * replay returns the first attempt's stored response BEFORE any blob write,
 * so a retry can never duplicate the capture or stack a second stored object.
 * 4.5 MB function body limit is the Vercel ceiling, same as document upload.
 */
export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return problemResponse(415, "unsupported_media_type", "Upload as multipart/form-data.");
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return problemResponse(400, "invalid_request", "Attach a file in the 'file' field.");
  }
  if (file.size > MAX_CAPTURE_UPLOAD_BYTES) {
    return problemResponse(413, "payload_too_large", `Captures are limited to ${MAX_UPLOAD_LABEL} - the largest upload this deployment accepts.`);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = validateFile(bytes, file.name);
  if (!verdict.ok && verdict.reason === "empty_file") {
    return problemResponse(400, "empty_file", "The uploaded file is empty.");
  }

  // The receipt payload is one shared shape: this pre-check and the command's
  // in-transaction receipt hash the same object, so a replay can never read a
  // conflict out of its own first attempt.
  const contentHash = await sha256Hex(bytes);
  const receiptRequest = fileCaptureReceiptRequest(contentHash, file.name.trim().slice(0, 500) || "file");
  if (idempotencyKey) {
    const [receipt] = await db
      .select({ requestHash: requestReceipts.requestHash, response: requestReceipts.response })
      .from(requestReceipts)
      .where(and(eq(requestReceipts.workspaceId, auth.workspaceId), eq(requestReceipts.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== (await receiptRequestHash(receiptRequest))) {
        return problemResponse(422, "idempotency_conflict", "This key was used for a different request.");
      }
      return Response.json(receipt.response, { status: 201 });
    }
  }

  try {
    const result = await createFileCapture(auth, {
      bytes,
      filename: file.name,
      verdict,
      contentHash,
      source: "quick_capture",
      idempotencyKey: idempotencyKey ?? undefined,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ObjectStoreUnconfiguredError) {
      return problemResponse(503, "storage_unconfigured", error.message);
    }
    if (error instanceof StorageWriteFailedError) {
      return problemResponse(503, "storage_unavailable", error.message);
    }
    if (error instanceof IdempotencyConflictError) {
      return problemResponse(422, "idempotency_conflict", error.message);
    }
    if (error instanceof ConflictError) {
      return problemResponse(400, "invalid_request", error.message);
    }
    throw error;
  }
});
