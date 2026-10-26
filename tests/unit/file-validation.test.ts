import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, validateFile } from "@/lib/file-validation";

/*
 * Content is truth: the client's filename, extension, and content-type are
 * claims, never evidence. A PDF renamed to .png must still read as a PDF, and
 * a text file must never pass on the strength of its metadata.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const TEXT = new TextEncoder().encode("just some plain text, definitely not a pdf");

describe("validateFile", () => {
  it("detects a PDF by its magic bytes even when renamed to .png", () => {
    // The bytes are a PDF; what the upload was called is irrelevant.
    expect(validateFile(PDF)).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("accepts a real PNG and a real JPEG", () => {
    expect(validateFile(PNG)).toEqual({ ok: true, mimeType: "image/png" });
    expect(validateFile(JPEG)).toEqual({ ok: true, mimeType: "image/jpeg" });
  });

  it("sniffs a text file with a fake %PDF prefix at byte 0 as a PDF (content is truth)", () => {
    const fake = new TextEncoder().encode("%PDF-fake but really text");
    expect(validateFile(fake)).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("accepts a plain text file by its printable content, not its metadata", () => {
    expect(validateFile(TEXT)).toEqual({ ok: true, mimeType: "text/plain" });
  });

  it("accepts a CSV as text — a CSV is a text document", () => {
    const csv = new TextEncoder().encode("name,amount\nAshwin,1200\nNadia,940\n");
    expect(validateFile(csv)).toEqual({ ok: true, mimeType: "text/plain" });
  });

  it("rejects a binary that matches no signature and is not printable text", () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]);
    expect(validateFile(binary)).toEqual({ ok: false, reason: "unidentified" });
  });

  it("rejects an empty file", () => {
    expect(validateFile(new Uint8Array(0))).toEqual({ ok: false, reason: "empty_file" });
  });

  it("rejects a file over the 4 MB cap", () => {
    // Cap is checked before sniffing; one oversized buffer covers both orders.
    expect(validateFile(new Uint8Array(MAX_UPLOAD_BYTES + 1))).toEqual({
      ok: false,
      reason: "payload_too_large",
    });
  });
});

describe("validateFile binary-extension quarantine", () => {
  it("quarantines text bytes carrying a binary extension", () => {
    expect(validateFile(TEXT, "notes.pdf")).toEqual({ ok: false, reason: "unidentified" });
    expect(validateFile(TEXT, "photo.png")).toEqual({ ok: false, reason: "unidentified" });
  });

  it("still accepts text bytes with a text extension or no extension", () => {
    expect(validateFile(TEXT, "notes.csv")).toEqual({ ok: true, mimeType: "text/plain" });
    expect(validateFile(TEXT, "notes.txt")).toEqual({ ok: true, mimeType: "text/plain" });
    expect(validateFile(TEXT)).toEqual({ ok: true, mimeType: "text/plain" });
  });

  it("content still wins: a real PDF named .png stays a PDF", () => {
    expect(validateFile(PDF, "renamed.png")).toEqual({ ok: true, mimeType: "application/pdf" });
  });
});

describe("validateFile audio (ASH-314 voice captures)", () => {
  const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
  const MP3_ID3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
  const MP3_FRAME = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]);
  const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  const M4A = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);

  it("sniffs the formats MediaRecorder and phones actually produce", () => {
    expect(validateFile(WEBM, "voice-note.webm")).toEqual({ ok: true, mimeType: "audio/webm" });
    expect(validateFile(MP3_ID3, "memo.mp3")).toEqual({ ok: true, mimeType: "audio/mpeg" });
    expect(validateFile(MP3_FRAME, "memo.mp3")).toEqual({ ok: true, mimeType: "audio/mpeg" });
    expect(validateFile(OGG, "memo.ogg")).toEqual({ ok: true, mimeType: "audio/ogg" });
    expect(validateFile(M4A, "voice-note.m4a")).toEqual({ ok: true, mimeType: "audio/mp4" });
  });

  it("splits the RIFF container by its fourcc: WAVE is audio, WEBP is an image, AVI is refused", () => {
    expect(validateFile(WAV, "memo.wav")).toEqual({ ok: true, mimeType: "audio/wav" });
    const AVI = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(validateFile(AVI, "clip.avi")).toEqual({ ok: false, reason: "unidentified" });
  });

  it("a webp still sniffs as image/webp after the fourcc split", () => {
    const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(validateFile(WEBP, "shot.webp")).toEqual({ ok: true, mimeType: "image/webp" });
  });

  it("quarantines text bytes carrying an audio extension", () => {
    expect(validateFile(TEXT, "not-audio.webm")).toEqual({ ok: false, reason: "unidentified" });
    expect(validateFile(TEXT, "not-audio.m4a")).toEqual({ ok: false, reason: "unidentified" });
  });

  it("an unknown ftyp brand is not audio", () => {
    const QT = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
    expect(validateFile(QT, "clip.mov")).toEqual({ ok: false, reason: "unidentified" });
  });
});
