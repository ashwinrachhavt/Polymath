/*
 * One cleanup pass over extracted text, applied inside each adapter before
 * spans are computed, so documentExtractions.text is clean at rest for every
 * producer. Pure and lossless on content: whitespace hygiene only. Never run
 * it after spans exist — trimming and collapsing shift every offset after the
 * edit point (pdf-text-layer and llamaparse accumulate per-page spans over
 * the joined text).
 */

const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** docling-serve occasionally emits bare "- 3 -" artifact lines between pages. */
const PAGE_MARKER_LINE = /^-\s*\d+\s*-$/;

export function normalizePageText(text: string): string {
  return text.replace(CONTROL_CHAR, "").replace(/[ \t]+$/gm, "");
}

export function normalizeExtractedText(
  text: string,
  format: "markdown" | "plain",
): string {
  let working = normalizePageText(text);
  const lines = working.split("\n");
  if (format === "markdown") {
    while (lines.length && PAGE_MARKER_LINE.test(lines[0]!.trim())) lines.shift();
    while (lines.length && PAGE_MARKER_LINE.test(lines[lines.length - 1]!.trim())) lines.pop();
  }
  working = lines.join("\n");
  // Three or more consecutive blank lines collapse to one.
  working = working.replace(/\n{4,}/g, "\n\n");
  return working.trim();
}
