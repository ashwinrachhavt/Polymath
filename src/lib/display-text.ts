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
