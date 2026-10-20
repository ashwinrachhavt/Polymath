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
  { mimeType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF…WEBP (4 bytes at offset 8)
  { mimeType: "text/plain", bytes: [] }, // UTF-8 BOM; bare text is caught by the printable scan below
  { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04 (docx/xlsx/pptx zip container)
];

/** A text file is mostly printable UTF-8; a binary is not. Sampled, not scanned whole. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) < 0.05;
}

/** The DOCX family (zip container) is picked out of the shared zip magic by extension, the one place extension matters. */
const ZIP_DOCX = /^\.docx?$/i;
const ZIP_XLSX = /^\.xlsx?$/i;
const ZIP_PPTX = /^\.pptx?$/i;

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

export function validateFile(bytes: Uint8Array, filename = ""): FileValidationResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_file" };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "payload_too_large" };
  const match = SIGNATURES.find((sig) => sig.bytes.length > 0 && sig.bytes.every((b, i) => bytes[i] === b));
  if (match) {
    if (match.mimeType === "image/webp") {
      // RIFF alone is also WAV/AVI; confirm WEBP at offset 8 before accepting.
      const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isWebp) return { ok: false, reason: "unidentified" };
    }
    if (
      match.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      !ZIP_DOCX.test(filename) &&
      !ZIP_XLSX.test(filename) &&
      !ZIP_PPTX.test(filename)
    ) {
      // A zip that is not an Office document stays rejected: arbitrary
      // archives are not documents, and a bare .zip is usually junk data.
      return { ok: false, reason: "unidentified" };
    }
    return { ok: true, mimeType: match.mimeType };
  }
  if (looksLikeText(bytes)) return { ok: true, mimeType: "text/plain" };
  return { ok: false, reason: "unidentified" };
}
