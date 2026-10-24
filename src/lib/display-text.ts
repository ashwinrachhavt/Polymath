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
    .replace(/^#{1,6}\s+/gm, "");
  return text.replace(/\s+/g, " ").trim();
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
