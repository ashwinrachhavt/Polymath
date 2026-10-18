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

  it("rejects a text file that does not match any allowlisted signature", () => {
    expect(validateFile(TEXT)).toEqual({ ok: false, reason: "unidentified" });
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
