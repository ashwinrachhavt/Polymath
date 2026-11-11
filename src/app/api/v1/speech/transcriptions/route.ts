import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, validateFile } from "@/lib/file-validation";
import { transcribeDictation } from "@/domains/speech/dictation";

/*
 * POST /api/v1/speech/transcriptions - one recorded dictation clip in, its
 * words out as `{ text }` ("" when there was no speech). The body is the raw
 * clip exactly as MediaRecorder produced it, so the browser posts the Blob
 * with no form wrapping. The type is sniffed from the bytes; the client's
 * content-type is ignored. The clip is never stored: it lives only in this
 * request.
 *
 * Signed-in people only. The scope below is one no API key can be granted
 * (identity/machine.ts API_KEY_SCOPES), and machine credentials always carry
 * a scope list, so companion keys and Clerk machine tokens are refused while
 * a browser session passes on its role.
 */
export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  requireScope(auth, "speech:dictate");

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) return tooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge();
  if (bytes.byteLength === 0) return problemResponse(400, "empty_file", "The recording is empty.");

  const verdict = validateFile(bytes);
  if (!verdict.ok || !verdict.mimeType.startsWith("audio/")) {
    return problemResponse(415, "unsupported_media_type", "Send a recorded audio clip (WebM, Ogg, MP4, MP3 or WAV).");
  }

  const outcome = await transcribeDictation(auth, { bytes, mimeType: verdict.mimeType });
  switch (outcome.kind) {
    case "transcribed":
      return Response.json({ text: outcome.text }, { headers: { "cache-control": "no-store" } });
    case "unconfigured":
      return problemResponse(503, "transcription_unconfigured", "Dictation is not set up on this deployment.");
    case "exhausted":
      return problemResponse(429, "quota_exhausted", "The transcription allowance is used up.");
    case "failed":
      return problemResponse(502, "transcription_failed", "The transcription service did not answer. Try again.");
  }
});

function tooLarge(): Response {
  return problemResponse(413, "payload_too_large", `A dictation clip is limited to ${MAX_UPLOAD_LABEL}.`);
}
