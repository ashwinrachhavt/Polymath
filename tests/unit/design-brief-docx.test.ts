import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { designBriefDocx, designBriefDocxSha256, designBriefDocumentXml } from "@/domains/knowledge/design-brief-docx";
import type { DesignBrief } from "@/domains/knowledge/design-brief";

/*
 * The DOCX the Canva handoff uploads. The pins: a real OOXML zip shape, every
 * brief field present and XML-escaped, and byte-for-byte determinism - the
 * approved payload pins the render's SHA-256, so an unstable render would
 * break the executor's integrity gate.
 */

const brief: DesignBrief = {
  title: "Launch one-pager",
  objective: "Get the team aligned on the launch story.",
  audience: "Founders and early customers",
  keyMessage: "The research card becomes the pitch.",
  tone: ["direct", "warm"],
  format: "doc",
  visualDirection: "Sparse, typographic, one accent color.",
  deliverables: ["One-pager", "Social crop"],
  constraints: ["No stock photography"],
  callToAction: "Book a demo",
};

/** Read the store-only zip buildZip writes: local headers in entry order. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // central directory reached
    const size = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const data = bytes.subarray(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + size);
    entries.set(name, new TextDecoder().decode(data));
    offset += 30 + nameLen + extraLen + size;
  }
  return entries;
}

describe("designBriefDocx", () => {
  it("builds a valid OOXML package with the three required parts", () => {
    const entries = unzip(designBriefDocx(brief));
    expect([...entries.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    expect(entries.get("[Content_Types].xml")).toContain("wordprocessingml.document.main+xml");
    expect(entries.get("_rels/.rels")).toContain('Target="word/document.xml"');
    expect(entries.get("word/document.xml")).toContain("wordprocessingml/2006/main");
  });

  it("carries every brief field, with nulls shown as absent", () => {
    const xml = designBriefDocumentXml(brief);
    for (const text of [
      "Design brief: Launch one-pager",
      "Format: doc",
      "Objective",
      "Get the team aligned on the launch story.",
      "Audience",
      "Founders and early customers",
      "Key message",
      "Tone",
      "direct, warm",
      "Visual direction",
      "Deliverables",
      "• One-pager",
      "• Social crop",
      "Constraints",
      "• No stock photography",
      "Call to action",
      "Book a demo",
    ]) {
      expect(xml).toContain(text);
    }

    const sparse = designBriefDocumentXml({ ...brief, deliverables: null, constraints: null, callToAction: null });
    expect(sparse.match(/None given\./g)?.length).toBe(3);
  });

  it("XML-escapes brief content", () => {
    const xml = designBriefDocumentXml({
      ...brief,
      title: 'A & B <draft> "v2"',
      objective: "5 > 3 & 2 < 4",
    });
    expect(xml).toContain("A &amp; B &lt;draft&gt; &quot;v2&quot;");
    expect(xml).toContain("5 &gt; 3 &amp; 2 &lt; 4");
    expect(xml).not.toContain("<draft>");
  });

  it("is deterministic: same brief, same bytes, same hash", () => {
    const a = designBriefDocx(brief);
    const b = designBriefDocx({ ...brief });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(designBriefDocxSha256(brief)).toBe(createHash("sha256").update(a).digest("hex"));
    expect(designBriefDocxSha256(brief)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes bytes when the brief changes", () => {
    expect(designBriefDocxSha256(brief)).not.toBe(designBriefDocxSha256({ ...brief, title: "Other" }));
  });
});
