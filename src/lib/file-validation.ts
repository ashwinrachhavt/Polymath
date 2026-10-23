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

/**
 * Extensions that declare a binary type. Content still wins for the
 * renamed-PDF case, but text bytes carrying one of these names is a sniff
 * mismatch, not a text upload: quarantine it rather than file it as a
 * document it cannot be.
 */
const BINARY_EXTENSIONS = /\.(pdf|jpe?g|png|webp|docx?|xlsx?|pptx?)$/i;

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
  if (looksLikeText(bytes)) {
    if (BINARY_EXTENSIONS.test(filename)) return { ok: false, reason: "unidentified" };
    return { ok: true, mimeType: "text/plain" };
  }
  return { ok: false, reason: "unidentified" };
}

/*
 * Audio sniffing (voice capture intake): magic-grounded, never the filename.
 * Every accepted type is a real signature checked at its spec offset; a
 * mismatch is "unidentified" and the caller quarantines the original rather
 * than filing it under a claimed type. A renamed video or PDF does not pass:
 * RIFF must prove WAVE at offset 8 (AVI/WEBP fail), an ISO-BMFF file must
 * declare an audio brand (M4A / M4B), EBML alone is accepted as WebM because
 * browsers record microphone audio to it and the bytes stay honest - the
 * capture never promises playability beyond the sniffed container.
 */
const AUDIO_SIGNATURES: { mimeType: string; sniff: (b: Uint8Array) => boolean }[] = [
  { mimeType: "audio/wav", sniff: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45 }, // RIFF....WAVE
  { mimeType: "audio/mpeg", sniff: (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) }, // ID3 or frame sync
  { mimeType: "audio/ogg", sniff: (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 }, // OggS
  { mimeType: "audio/flac", sniff: (b) => b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43 }, // fLaC
  {
    mimeType: "audio/mp4",
    // ISO-BMFF: ftyp box at offset 4, and the major brand must be audio (M4A
    // or M4B). A video .mp4 (isom/mp41/mp42/avc1 brands) is not voice audio.
    sniff: (b) =>
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      ((b[8] === 0x4d && b[9] === 0x34 && b[10] === 0x41 && b[11] === 0x20) || // "M4A "
       (b[8] === 0x4d && b[9] === 0x34 && b[10] === 0x42 && b[11] === 0x20)), // "M4B "
  },
  { mimeType: "audio/webm", sniff: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 }, // EBML (WebM container; browser mic recordings)
];

export function validateAudioFile(bytes: Uint8Array): FileValidationResult {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty_file" };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "payload_too_large" };
  const match = AUDIO_SIGNATURES.find((sig) => sig.sniff(bytes));
  if (match) return { ok: true, mimeType: match.mimeType };
  return { ok: false, reason: "unidentified" };
}
