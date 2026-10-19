import { describe, expect, it } from "vitest";
import { buildZip, crc32 } from "@/lib/zip";

/*
 * The store-only zip writer: CRC32 known vectors, a structural read-back of
 * the archive it builds, and refusal of names that could escape an
 * extraction directory.
 */

describe("crc32", () => {
  it("matches published vectors", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("buildZip", () => {
  it("lays out entries a reader can walk back", () => {
    const a = new TextEncoder().encode("hello packet");
    const b = new TextEncoder().encode("second file bytes");
    const zip = buildZip([{ name: "01 - one.txt", bytes: a }, { name: "02 - two.txt", bytes: b }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // End of central directory at the tail.
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2);

    // Walk local headers from the front.
    const names: string[] = [];
    const contents: string[] = [];
    let offset = 0;
    const decoder = new TextDecoder();
    while (view.getUint32(offset, true) === 0x04034b50) {
      const method = view.getUint16(offset + 8, true);
      const crc = view.getUint32(offset + 14, true);
      const size = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLen));
      const body = zip.subarray(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + size);
      expect(method).toBe(0);
      expect(crc32(body)).toBe(crc);
      names.push(name);
      contents.push(decoder.decode(body));
      offset += 30 + nameLen + extraLen + size;
    }
    // After the locals comes the central directory.
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(names).toEqual(["01 - one.txt", "02 - two.txt"]);
    expect(contents).toEqual(["hello packet", "second file bytes"]);
  });

  it("refuses traversal and absolute names", () => {
    const bytes = new Uint8Array([1]);
    expect(() => buildZip([{ name: "../escape.txt", bytes }])).toThrowError(/unsafe/);
    expect(() => buildZip([{ name: "/abs.txt", bytes }])).toThrowError(/unsafe/);
    expect(() => buildZip([{ name: "C:/win.txt", bytes }])).toThrowError(/unsafe/);
  });
});
