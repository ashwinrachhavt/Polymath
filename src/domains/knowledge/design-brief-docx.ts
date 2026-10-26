import { createHash } from "node:crypto";
import { buildZip } from "@/lib/zip";
import type { DesignBrief } from "./design-brief";

/*
 * The brief as a Word document Canva's design import can read. Canva imports
 * PDF, DOCX and PPTX but not Markdown (design-imports reference, fetched
 * 2026-10-25); DOCX is a zip of XML this repo builds with no new dependency
 * (`buildZip` is a store-only writer), so the handoff carries the approved
 * brief rather than asking the owner to export anything.
 *
 * Deterministic by contract: the same brief renders to the same bytes. The
 * proposal pins this render's SHA-256 into the approved revision, and the
 * executor re-renders and refuses to run when the bytes would differ from
 * the ones the owner approved (a renderer change needs a fresh approval,
 * not a silent substitution).
 *
 * Canva's own fidelity for a minimal OOXML document is NOT verified yet -
 * that takes one real, owner-approved import. The review card says so.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One paragraph. Direct run formatting only, so no styles part is required. */
function paragraph(text: string, opts?: { bold?: boolean; sizePt?: number }): string {
  const runProps =
    opts?.bold || opts?.sizePt
      ? `<w:rPr>${opts?.bold ? "<w:b/>" : ""}${opts?.sizePt ? `<w:sz w:val="${opts.sizePt * 2}"/>` : ""}</w:rPr>`
      : "";
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function list(items: string[] | null): string[] {
  return items && items.length > 0 ? items.map((item) => `• ${item}`) : ["None given."];
}

export function designBriefDocumentXml(brief: DesignBrief): string {
  const parts = [
    paragraph(`Design brief: ${brief.title}`, { bold: true, sizePt: 24 }),
    paragraph(`Format: ${brief.format}`),
    paragraph("Objective", { bold: true }),
    paragraph(brief.objective),
    paragraph("Audience", { bold: true }),
    paragraph(brief.audience),
    paragraph("Key message", { bold: true }),
    paragraph(brief.keyMessage),
    paragraph("Tone", { bold: true }),
    paragraph(brief.tone.join(", ")),
    paragraph("Visual direction", { bold: true }),
    paragraph(brief.visualDirection),
    paragraph("Deliverables", { bold: true }),
    ...list(brief.deliverables).map((item) => paragraph(item)),
    paragraph("Constraints", { bold: true }),
    ...list(brief.constraints).map((item) => paragraph(item)),
    paragraph("Call to action", { bold: true }),
    paragraph(brief.callToAction ?? "None given."),
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join("")}<w:sectPr/></w:body></w:document>`;
}

export function designBriefDocx(brief: DesignBrief): Uint8Array {
  const encoder = new TextEncoder();
  return buildZip([
    { name: "[Content_Types].xml", bytes: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: encoder.encode(RELS) },
    { name: "word/document.xml", bytes: encoder.encode(designBriefDocumentXml(brief)) },
  ]);
}

export function designBriefDocxSha256(brief: DesignBrief): string {
  return createHash("sha256").update(designBriefDocx(brief)).digest("hex");
}
