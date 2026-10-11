import type { Recurrence } from "./types";

/*
 * The block palette behind the `/` menu. One list, shared by every rich text
 * surface, so a slash command means the same thing in a note, a blog draft and
 * a dossier.
 */

export type BlockCommand = { id: string; label: string; keywords: string[]; hint: string };
export const blockCommands: BlockCommand[] = [
  { id: "heading", label: "Heading", keywords: ["h2", "title", "section"], hint: "Section heading" },
  { id: "bulletList", label: "Bulleted list", keywords: ["ul", "list", "bullets"], hint: "Unordered list" },
  { id: "orderedList", label: "Numbered list", keywords: ["ol", "list", "steps"], hint: "Ordered list" },
  { id: "blockquote", label: "Quote", keywords: ["quote", "blockquote", "cite"], hint: "Quoted passage" },
  { id: "codeBlock", label: "Code block", keywords: ["code", "pre", "snippet"], hint: "Monospaced code" },
  { id: "horizontalRule", label: "Divider", keywords: ["hr", "rule", "divider"], hint: "Horizontal rule" },
];

/*
 * Empty when the caret is not somewhere a command can start. Otherwise the
 * text between the slash and the caret, which is what the menu filters on.
 */
export function slashQuery(textBeforeCursor: string) {
  const match = /(?:^|\s)\/([a-z0-9]*)$/i.exec(textBeforeCursor);
  return match ? match[1].toLowerCase() : undefined;
}

export function filterBlockCommands(query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return blockCommands;
  return blockCommands.filter((command) => command.label.toLowerCase().includes(needle) || command.keywords.some((keyword) => keyword.startsWith(needle)));
}

export type RecurrencePreset = { id: string; label: string; recurrence?: Recurrence };
export const recurrencePresets: RecurrencePreset[] = [
  { id: "none", label: "Does not repeat" },
  { id: "daily", label: "Every day", recurrence: { frequency: "daily", interval: 1 } },
  { id: "weekdays", label: "Every weekday", recurrence: { frequency: "daily", interval: 1 } },
  { id: "weekly", label: "Every week", recurrence: { frequency: "weekly", interval: 1 } },
  { id: "biweekly", label: "Every 2 weeks", recurrence: { frequency: "weekly", interval: 2 } },
  { id: "monthly", label: "Every month", recurrence: { frequency: "monthly", interval: 1 } },
];

export function recurrenceForPreset(id: string): Recurrence | undefined {
  return recurrencePresets.find((preset) => preset.id === id)?.recurrence;
}

export function presetForRecurrence(recurrence?: Recurrence) {
  if (!recurrence) return "none";
  return recurrencePresets.find((preset) => preset.recurrence && preset.recurrence.frequency === recurrence.frequency && preset.recurrence.interval === recurrence.interval)?.id ?? "none";
}
