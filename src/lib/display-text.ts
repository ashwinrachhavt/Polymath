/*
 * Display text for raw user/model input. Objectives and conversation titles
 * are stored verbatim (a run's objective is also its first message), but list
 * rows, headers and briefing cards show them as plain text: markdown syntax
 * leaking into a title reads as corruption, and a long raw URL pushes out the
 * words a person scans for.
 */
export function displayTitle(raw: string): string {
  const text = raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
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
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "");
}
