/*
 * Reads the line diff a Notion proposal stores in its revision preview
 * (see appendPreview in notion-proposals.ts). Kept free of database imports so
 * the review card and its tests can share one parser instead of each guessing
 * at the format.
 */

export type DiffLine = { kind: "add" | "context" | "gap"; text: string };

export type NotionDiffPreview = {
  contentHash: string;
  title: string;
  url: string | null;
  lines: DiffLine[];
};

export function parseDiffLines(diff: string): DiffLine[] {
  return diff.split("\n").map((line): DiffLine => {
    if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
    if (line.trim() === "…") return { kind: "gap", text: "" };
    return { kind: "context", text: line.startsWith(" ") ? line.slice(1) : line };
  });
}

/**
 * A create proposal stores the raw markdown as its diff, so every line is an
 * addition; an append stores prefixed lines. Anything that is not a diff
 * preview returns null and the card falls back to the raw payload.
 */
export function readNotionDiffPreview(preview: unknown, mode: "append" | "create"): NotionDiffPreview | null {
  if (!preview || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  if (value.kind !== "diff" || typeof value.diff !== "string" || typeof value.contentHash !== "string") return null;
  const lines =
    mode === "create"
      ? value.diff.split("\n").map((text): DiffLine => ({ kind: "add", text }))
      : parseDiffLines(value.diff);
  return {
    contentHash: value.contentHash,
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : null,
    lines,
  };
}
