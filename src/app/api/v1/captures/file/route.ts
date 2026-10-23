import { authedHandler } from "@/lib/auth";
import { validateFile } from "@/lib/file-validation";
import { createFileCapture, fileCaptureReceiptRequest } from "@/domains/capture/commands";
import { handleBlobCaptureUpload, MAX_CAPTURE_UPLOAD_BYTES } from "../blob-upload";

// Re-exported: existing consumers (and tests) import the cap from this route.
export { MAX_CAPTURE_UPLOAD_BYTES };

/*
 * POST /api/v1/captures/file - upload a file or screenshot straight into the
 * inbox. Same contract as document upload: content sniffing decides the type
 * (the client's filename and content-type are never trusted), a mismatch
 * quarantines the original instead of rejecting it, and an Idempotency-Key
 * replay returns the first attempt's stored response BEFORE any blob write,
 * so a retry can never duplicate the capture or stack a second stored object.
 * 4.5 MB function body limit is the Vercel ceiling, same as document upload.
 * The implementation is shared with the voice route; only the sniff, the
 * command and the receipt op differ.
 */
export const POST = authedHandler(async (auth, request) =>
  handleBlobCaptureUpload(auth, request, {
    noun: "file",
    validate: validateFile,
    create: createFileCapture,
    receiptRequest: fileCaptureReceiptRequest,
  }),
);
