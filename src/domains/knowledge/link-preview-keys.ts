const MAX_PREVIEW_TITLES = 50;

/**
 * The title keys a preview lookup queries: trimmed, lower-cased, deduped and
 * capped. Only these were looked up, so only these can be judged missing.
 */
export function linkPreviewKeys(titles: string[]): string[] {
  return [...new Set(titles.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_PREVIEW_TITLES);
}
