export type LinkTarget = { id: string; title: string; kind: string; version?: number; href?: string };

/*
 * Link text must survive the round trip through the editor's Markdown
 * serialization: a target title carrying [, ], \ or a line break would split
 * the [text](href) construct the mark serializes to (or the [[wiki link]]
 * delimiters), so those characters are stripped and whitespace collapsed.
 * The href itself is always one of our own uuid-routed URLs, never user text.
 */
export function sanitizeLinkText(title: string): string {
  const cleaned = title.replace(/[[\]\\]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : "Untitled";
}

/*
 * What picking a target inserts. A note/zettel becomes a [[wiki link]] so the
 * save path grows a graph edge; anything else (captures, tasks, other
 * artifacts the picker may return) has no edge semantics, so it becomes a
 * real Markdown link to the target's canonical route - render and click
 * resolve to the destination itself, never to a dangling [[title]].
 */
export function linkTargetInsertion(match: LinkTarget): string | { type: string; text: string; marks: { type: string; attrs: { href: string } }[] }[] {
  if (!match.href) return `[[${sanitizeLinkText(match.title)}]] `;
  return [
    { type: "text", text: sanitizeLinkText(match.title), marks: [{ type: "link", attrs: { href: match.href } }] },
    { type: "text", text: " " },
  ];
}
