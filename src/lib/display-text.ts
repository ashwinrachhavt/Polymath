/*
 * Display text for raw user/model input. Objectives and conversation titles
 * are stored verbatim (a run's objective is also its first message), but list
 * rows, headers and briefing cards show them as plain text: markdown syntax
 * leaking into a title reads as corruption, and a long raw URL pushes out the
 * words a person scans for.
 *
 * Emphasis markers strip only when they hug their content without a space and
 * sit at a word edge — `**bold**` and `_it_` go, `2 * 3 * 4` and
 * `snake_case_name` stay. The marker side must not follow/lead an alnum and
 * the content must not start/end with a space.
 */
const EMPHASIS = /(^|[^\w*_[`\\])([*_~]{1,3})(?=\S)([^*_\s][^*_]*?)(?<=\S)\2(?![\w*_])/g;

export function displayTitle(raw: string): string {
  const text = raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(EMPHASIS, "$1$3")
    .replace(/^(?:\s*>)+\s?/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "");
  return text.replace(/\s+/g, " ").trim();
}

const HEADING_1 = /^#\s+\S/;
const QUOTED = /^>/;
/* A line that is only markup around a heading, e.g. "> ## Documentation
   Index": save it as a title and the page shows the source syntax. */
const MARKUP_ONLY = /^[\s>#*_~`\-]+$/;

/**
 * The title a piece of captured text gives itself. A page saved as markdown
 * often opens with a quoted site notice above its real heading (docs sites
 * prepend the same "Documentation Index" note to every page), so a level-one
 * heading wins when only quoted lines come before it; otherwise the first
 * line that still has words once its markdown is stripped. Returns
 * `fallback` for text with no words.
 */
export function titleFromText(text: string, fallback: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  /*
   * A heading under a quoted notice beats the notice itself. `afterQuotes` is
   * the first line that is not quoted AND not a bare fence/rule, so a page
   * that opens "> ## Documentation Index" then ">" then "# Real Title" is
   * titled by its own page heading rather than by the site's notice.
   */
  const afterQuotes = lines.find((line) => !QUOTED.test(line) && !MARKUP_ONLY.test(displayTitle(line)));
  const chosen = afterQuotes && HEADING_1.test(afterQuotes) ? [afterQuotes] : lines;
  for (const line of chosen) {
    const title = displayTitle(line);
    if (title) return title;
  }
  /*
   * Every line was markup: a page whose first words are a quoted heading
   * after a quoted notice, or a bare fence. The first readable words anywhere
   * in the text beat a title made of syntax.
   */
  for (const line of lines) {
    const title = displayTitle(line);
    if (title && !MARKUP_ONLY.test(title)) return title;
  }
  return fallback;
}

/*
 * Plain text for the searchable/preview column: the editor sends the raw
 * markdown it holds, but a preview that shows `#` and `**` reads as breakage.
 * Same stripping as displayTitle, but line structure is preserved (previews
 * and search index the note's first line).
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(EMPHASIS, "$1$3")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "");
}

/**
 * A capture's stored title, cleaned for display. Titles written before
 * 2026-11-12 could hold raw markdown ("> ## Documentation Index"); the row is
 * not rewritten, so every reader cleans what it prints instead.
 */
export function captureDisplayTitle(row: { title?: string | null }): string | null {
  const raw = row.title?.trim();
  if (!raw) return null;
  const cleaned = displayTitle(raw);
  return cleaned || null;
}
