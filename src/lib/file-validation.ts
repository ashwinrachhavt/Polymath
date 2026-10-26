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
  { mimeType: "audio/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // EBML - webm/matroska, what MediaRecorder emits
  { mimeType: "audio/mpeg", bytes: [0x49, 0x44, 0x33] }, // ID3
  { mimeType: "audio/mpeg", bytes: [0xff, 0xfb] }, // mp3 frame sync
  { mimeType: "audio/mpeg", bytes: [0xff, 0xf3] },
  { mimeType: "audio/mpeg", bytes: [0xff, 0xf2] },
  { mimeType: "audio/ogg", bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { mimeType: "text/plain", bytes: [] }, // UTF-8 BOM; bare text is caught by the printable scan below
  { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04 (docx/xlsx/pptx zip container)
];

/**
 * Extensions that declare a binary type. Content still wins for the
 * renamed-PDF case, but text bytes carrying one of these names is a sniff
 * mismatch, not a text upload: quarantine it rather than file it as a
 * document it cannot be.
 */
const BINARY_EXTENSIONS = /\.(pdf|jpe?g|png|webp|docx?|xlsx?|pptx?|webm|mp3|ogg|wav|m4a)$/i;

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
const ZIP_DOCX = /\.(docx|doc)$/i;
const ZIP_XLSX = /\.(xlsx|xls)$/i;
const ZIP_PPTX = /\.(pptx|ppt)$/i;

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

/** ISO-BMFF audio (m4a/mp4 from Safari's MediaRecorder) declares 'ftyp' at offset 4 and its brand at 8. Video brands overlap (isom/mp42); the verdict only routes the upload, and a mismatch still quarantines, so a video misread as audio/mp4 costs a label, never a silent accept of something else. */
function sniffIsoBmffAudio(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return null;
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return ["M4A ", "M4B ", "mp41", "mp42", "isom", "iso2"].includes(brand) ? "audio/mp4" : null;
}

export function validateFile(bytes: Uint8Array, filename = ""): FileValidationResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_file" };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "payload_too_large" };
  const bmffAudio = sniffIsoBmffAudio(bytes);
  if (bmffAudio) return { ok: true, mimeType: bmffAudio };
  const match = SIGNATURES.find((sig) => sig.bytes.length > 0 && sig.bytes.every((b, i) => bytes[i] === b));
  if (match) {
    if (match.mimeType === "image/webp") {
      // RIFF is a container: WAV and AVI share the magic. The fourcc at
      // offset 8 decides - WEBP or WAVE are known, anything else is not.
      const fourcc = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (fourcc === "WAVE") return { ok: true, mimeType: "audio/wav" };
      if (fourcc !== "WEBP") return { ok: false, reason: "unidentified" };
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
  if (looksLikeText(bytes)) {
    if (BINARY_EXTENSIONS.test(filename)) return { ok: false, reason: "unidentified" };
    return { ok: true, mimeType: "text/plain" };
  }
  return { ok: false, reason: "unidentified" };
}
