export type MarkdownEditorMode = "rich" | "source";

export function markdownSourceReason(content: string): string | undefined {
  if (content.split(/\r?\n/).some((line) => line.includes("|") && /^\s*(?:>\s*)*[|:\-\s]+$/.test(line) && /-/.test(line))) return "tables";
  if (/!\[[\s\S]*?\](?:\s*\(|\s*\[)/.test(content)) return "images";
  if (/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/m.test(content)) return "task checkbox states";
  if (/<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/m.test(content)) return "raw HTML";
  if (/^\s*(?:>\s*)*\[[^\]\n]+\]:\s*\S/m.test(content) || /!?\[[^\]\n]*\]\s*\[[^\]\n]*\]/.test(content) || /\[\^[^\]\n]+\]/.test(content)) return "reference links, images or footnotes";
  return undefined;
}

export function markdownEditorMode(content: string, preferred: MarkdownEditorMode = "rich"): MarkdownEditorMode {
  return markdownSourceReason(content) ? "source" : preferred;
}
