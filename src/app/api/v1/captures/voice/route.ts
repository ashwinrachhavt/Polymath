import { authedHandler } from "@/lib/auth";
import { validateAudioFile } from "@/lib/file-validation";
import { createVoiceCapture, voiceCaptureReceiptRequest } from "@/domains/capture/commands";
import { handleBlobCaptureUpload } from "../blob-upload";

/*
 * POST /api/v1/captures/voice - attach RECORDED audio (a voice memo, a
 * recording) straight into the inbox. This is attach-only storage: it is not
 * microphone recording (no in-app recorder exists) and not transcription (no
 * pipeline exists) - the audio is stored as-is, its contents are never
 * promised as searchable or transcribed, and a sniff mismatch quarantines the
 * original instead of rejecting it. The container is decided by magic-byte
 * sniffing (WAV/MP3/Ogg/FLAC/M4A-M4B/WebM), never by filename or the client's
 * content-type. Same deploy-supported 4 MB ceiling, receipt pre-check and
 * idempotency contract as the file route - one shared implementation.
 */
export const POST = authedHandler(async (auth, request) =>
  handleBlobCaptureUpload(auth, request, {
    noun: "audio",
    validate: validateAudioFile,
    create: createVoiceCapture,
    receiptRequest: voiceCaptureReceiptRequest,
  }),
);
