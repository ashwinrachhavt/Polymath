/*
 * Upload validation by content, not by what the client claims (ASH-125). A
 * PDF renamed to .png must be detected as a PDF; a text file must never pass
 * because its extension or content-type said pdf. Magic-byte sniffing for the
 * v1 allowlist is a few lines, so no dependency.
 *
 * Extension plays no gate role: every rejection an extension check could make
 * is either already made by the sniff or would wrongly reject the
 * renamed-PDF case. Content wins.
 */

/** v1 allowlist. Add a type by adding its magic signature here and nowhere else. */
const SIGNATURES: { mimeType: string; bytes: number[] }[] = [
  { mimeType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] }, // \x89PNG
];

/*
 * 25 MB. A scanned 20-page PDF or a phone photo comfortably fits; anything
 * larger is a file the owner should process elsewhere first.
 *
 * Deployed on Vercel this is capped lower by the platform, not by us: a
 * serverless request body maxes out at 4.5 MB, so a bigger upload fails before
 * this check runs. Raising the deployed ceiling means the client-upload path
 * (direct to Blob, then finalize), which is separate work. Locally there is no
 * such limit.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type FileValidationResult =
  | { ok: true; mimeType: string }
  | { ok: false; reason: "empty_file" | "payload_too_large" | "unidentified" };

// PDF page-count/EOF sanity is deliberately out of scope: the magic check only
// routes the upload; a truncated PDF surfaces at extraction, not here.

export function validateFile(bytes: Uint8Array): FileValidationResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_file" };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "payload_too_large" };
  const match = SIGNATURES.find((sig) => sig.bytes.every((b, i) => bytes[i] === b));
  if (!match) return { ok: false, reason: "unidentified" };
  return { ok: true, mimeType: match.mimeType };
}
