import type { NoteContent } from "@/domains/knowledge/notes";

/*
 * The zettel body as blocks, so the claim and the evidence can be told apart.
 * Both the editor's doc JSON and a plain `{ text }` note render through here;
 * shared by the idea modal (the only reading surface now) and its tests.
 */

export type Block = { text: string; quote: boolean };
type DocNode = { type?: string; text?: string; content?: unknown[] };

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { text, content } = node as DocNode;
  if (typeof text === "string") return text;
  return Array.isArray(content) ? content.map(textOf).join("") : "";
}

export function blocksOf(content: NoteContent | null): Block[] {
  const nodes =
    content && Array.isArray((content as DocNode).content) ? ((content as DocNode).content as DocNode[]) : [];
  if (nodes.length === 0) {
    const text = content && typeof content.text === "string" ? content.text : "";
    return text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => ({ text: part.replace(/^>\s?/gm, ""), quote: part.startsWith(">") }));
  }
  // A paragraph can hold more than one logical block: ideas created by
  // commitDecomposition store the claim and its evidence in one node, with the
  // evidence as a `> quote` line. Splitting on blank lines and reading a
  // leading `>` keeps the evidence a quote instead of rendering the marker as
  // part of the claim.
  return nodes
    .flatMap((node) =>
      textOf(node)
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const quote = node.type === "blockquote" || part.startsWith(">");
          return { text: quote ? part.replace(/^>\s?/gm, "") : part, quote };
        }),
    )
    .filter((block) => block.text.length > 0);
}
