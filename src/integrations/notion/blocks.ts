/*
 * Markdown -> Notion blocks for the one write path (ASH-283). Deliberately
 * smaller than the reader: headings, list items, quotes, and paragraphs. An
 * inline link becomes a single rich-text part with an href, because Notion
 * stores links as run annotations, not markup.
 *
 * Anything the parser does not recognise stays a paragraph. A proposal's text
 * is model-written, so the worst case must be that it appears verbatim as
 * prose — never that a block is silently dropped, because the diff the owner
 * approved is the thing being applied.
 */

export type NotionBlockInput = {
  object: "block";
  type: string;
  [key: string]: unknown;
};

export const NOTION_BLOCK_LIMIT = 100;
export const NOTION_RICH_TEXT_LIMIT = 2000;

type RichText = { type: "text"; text: { content: string; link?: { url: string } } };

/** `[label](href)` inside a line becomes one linked rich-text part. */
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;

export function richTextParts(line: string): RichText[] {
  const parts: RichText[] = [];
  let cursor = 0;
  for (const match of line.matchAll(LINK)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ type: "text", text: { content: line.slice(cursor, at) } });
    parts.push({ type: "text", text: { content: match[1], link: { url: match[2] } } });
    cursor = at + match[0].length;
  }
  if (cursor < line.length) parts.push({ type: "text", text: { content: line.slice(cursor) } });
  return parts.flatMap(splitLongPart);
}

/** Notion rejects a rich-text run over 2000 chars; split rather than lose the tail. */
function splitLongPart(part: RichText): RichText[] {
  const content = part.text.content;
  if (content.length <= NOTION_RICH_TEXT_LIMIT) return [part];
  const out: RichText[] = [];
  for (let i = 0; i < content.length; i += NOTION_RICH_TEXT_LIMIT) {
    out.push({ type: "text", text: { content: content.slice(i, i + NOTION_RICH_TEXT_LIMIT), ...(part.text.link ? { link: part.text.link } : {}) } });
  }
  return out;
}

function textBlock(type: "paragraph" | "heading_1" | "heading_2" | "heading_3" | "quote", line: string): NotionBlockInput {
  const rt = richTextParts(line);
  return { object: "block", type, [type]: { rich_text: rt } };
}

/**
 * Convert markdown to blocks, in document order. A blank line ends a
 * paragraph; consecutive `-`/`*` lines become one bulleted list.
 */
export function markdownToBlocks(markdown: string): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push(textBlock("paragraph", text));
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
      flush();
      const level = (line.match(/^#+/)?.[0].length ?? 1) as 1 | 2 | 3;
      blocks.push(textBlock(`heading_${level}` as "heading_1" | "heading_2" | "heading_3", line.replace(/^#{1,3}\s+/, "")));
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richTextParts(bullet[1]) } });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push(textBlock("quote", quote[1]));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * A page's body is applied in chunks; the last partial chunk is what the caller
 * counts as applied so a retry cannot duplicate a block that landed.
 */
export function chunkBlocks(blocks: NotionBlockInput[], size = NOTION_BLOCK_LIMIT): NotionBlockInput[][] {
  const out: NotionBlockInput[][] = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}
