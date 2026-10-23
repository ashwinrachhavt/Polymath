import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth/guards";
import type { AuthContext } from "@/lib/auth";
import { problemResponse } from "@/lib/problems";
import { sha256Hex } from "@/lib/hash";
import type { FileValidationResult } from "@/lib/file-validation";
import { ObjectStoreUnconfiguredError } from "@/integrations/object-store/object-store";
import { requestReceipts } from "@/domains/audit/schema";
import { IdempotencyConflictError, receiptRequestHash } from "@/domains/audit/receipt";
import { ConflictError, StorageWriteFailedError } from "@/domains/capture/commands";

/*
 * The deploy-supported ceiling: 4 MB. Vercel caps a serverless request body
 * at 4.5 MB including multipart overhead, so a larger promise would fail at
 * the platform with a bare 413 before this code runs. Raising it means the
 * client-upload path (direct to Blob, then finalize) - separate work, same
 * as documents. The 25 MB library constant governs the offline/library
 * intake, not these routes.
 */
export const MAX_CAPTURE_UPLOAD_BYTES = 4 * 1024 * 1024;

/*
 * Shared blob-capture upload contract for the file and voice routes: same
 * multipart shape, same deploy-supported cap, same receipt pre-check BEFORE
 * any blob write (a replay returns the first attempt's stored response and
 * stores nothing), same error mapping. The routes differ only in what they
 * sniff, which command they call, and the receipt op - those come in as
 * config, never as a second copy of this logic.
 */
export async function handleBlobCaptureUpload(
  auth: AuthContext,
  request: Request,
  opts: {
    /** What the uploader is attaching, for honest error copy ("file" / "audio"). */
    noun: string;
    validate: (bytes: Uint8Array) => FileValidationResult;
    create: (
      auth: AuthContext,
      input: {
        bytes: Uint8Array;
        filename: string;
        verdict: FileValidationResult;
        contentHash: string;
        source: "quick_capture";
        idempotencyKey?: string;
      },
    ) => Promise<{ captureId: string; quarantined: boolean; contentHash: string }>;
    receiptRequest: (contentHash: string, filename: string) => { op: string; contentHash: string; filename: string };
  },
): Promise<Response> {
  requireRole(auth, "member");
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return problemResponse(415, "unsupported_media_type", "Upload as multipart/form-data.");
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return problemResponse(400, "invalid_request", `Attach a ${opts.noun} in the 'file' field.`);
  }
  if (file.size > MAX_CAPTURE_UPLOAD_BYTES) {
    return problemResponse(413, "payload_too_large", "Captures are limited to 4 MB - the largest upload this deployment accepts.");
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !z.string().uuid().safeParse(idempotencyKey).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const verdict = opts.validate(bytes);
  if (!verdict.ok && verdict.reason === "empty_file") {
    return problemResponse(400, "empty_file", "The uploaded file is empty.");
  }

  // The receipt payload is one shared shape: this pre-check and the command's
  // in-transaction receipt hash the same object, so a replay can never read a
  // conflict out of its own first attempt.
  const contentHash = await sha256Hex(bytes);
  const receiptRequest = opts.receiptRequest(contentHash, file.name.trim().slice(0, 500) || opts.noun);
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
    const result = await opts.create(auth, {
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
}
