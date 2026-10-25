export type TocEntry = { id: string; text: string; level: number };

/** The anchor id a heading renders with. Shared by the TOC and the body renderer, so they cannot drift. */
export function headingSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/**
 * The headings an artifact's markdown renders, in order — the table of
 * contents. Slugs are stable: the same heading text always produces the same
 * anchor id, which is what the detail page's sidebar links to.
 */
export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/[#\s]+$/, "");
    let id = headingSlug(text);
    if (seen.has(id)) {
      const n = seen.get(id)! + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 1);
    }
    entries.push({ id, text, level });
  }
  return entries;
}

