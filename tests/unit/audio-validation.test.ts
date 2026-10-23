import { describe, expect, it } from "vitest";
import { validateAudioFile } from "@/lib/file-validation";

/*
 * Audio sniffing is magic-grounded at spec offsets: a recognized container
 * declares its sniffed audio type, a video or renamed non-audio file is
 * never accepted on filename, and unidentified bytes quarantine rather than
 * reject. The route never decodes or plays the bytes; signature validity is
 * the property under test.
 */

const enc = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
const str = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
};

describe("validateAudioFile", () => {
  it("accepts a WAV by its RIFF/WAVE container", () => {
    const wav = cat(str("RIFF"), enc("00000000"), str("WAVE"), new Uint8Array(16));
    expect(validateAudioFile(wav)).toEqual({ ok: true, mimeType: "audio/wav" });
  });

  it("rejects a RIFF container that is not WAVE (an AVI video)", () => {
    const avi = cat(str("RIFF"), enc("00000000"), str("AVI "), new Uint8Array(16));
    expect(validateAudioFile(avi)).toEqual({ ok: false, reason: "unidentified" });
  });

  it("accepts MP3 by ID3 tag or MPEG frame sync", () => {
    expect(validateAudioFile(cat(str("ID3"), new Uint8Array(16)))).toEqual({ ok: true, mimeType: "audio/mpeg" });
    expect(validateAudioFile(cat(enc("fffb"), new Uint8Array(16)))).toEqual({ ok: true, mimeType: "audio/mpeg" });
  });

  it("accepts OGG, FLAC, and WebM by their container magics", () => {
    expect(validateAudioFile(cat(str("OggS"), new Uint8Array(16)))).toEqual({ ok: true, mimeType: "audio/ogg" });
    expect(validateAudioFile(cat(str("fLaC"), new Uint8Array(16)))).toEqual({ ok: true, mimeType: "audio/flac" });
    expect(validateAudioFile(cat(enc("1a45dfa3"), new Uint8Array(16)))).toEqual({ ok: true, mimeType: "audio/webm" });
  });

  it("accepts an ISO-BMFF file whose major brand is audio (M4A), and rejects a video brand", () => {
    const m4a = cat(enc("00000018"), str("ftyp"), str("M4A "), new Uint8Array(16));
    expect(validateAudioFile(m4a)).toEqual({ ok: true, mimeType: "audio/mp4" });
    const m4b = cat(enc("00000018"), str("ftyp"), str("M4B "), new Uint8Array(16));
    expect(validateAudioFile(m4b)).toEqual({ ok: true, mimeType: "audio/mp4" });
    const mp4video = cat(enc("00000018"), str("ftyp"), str("isom"), new Uint8Array(16));
    expect(validateAudioFile(mp4video)).toEqual({ ok: false, reason: "unidentified" });
    const avc1 = cat(enc("00000018"), str("ftyp"), str("avc1"), new Uint8Array(16));
    expect(validateAudioFile(avc1)).toEqual({ ok: false, reason: "unidentified" });
  });

  it("an empty upload is rejected, not quarantined", () => {
    expect(validateAudioFile(new Uint8Array([]))).toEqual({ ok: false, reason: "empty_file" });
  });

  it("a renamed non-audio file (a PDF called .mp3) is unidentified", () => {
    const pdf = cat(str("%PDF-1.7"), new Uint8Array(16));
    expect(validateAudioFile(pdf)).toEqual({ ok: false, reason: "unidentified" });
  });
});
