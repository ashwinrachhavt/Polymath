/*
 * Notion block JSON -> markdown. Pure: no I/O, no provider. Covers the block
 * types a personal knowledge base actually uses; anything unknown degrades to
 * its plain text rather than failing the page, so one exotic block never
 * stops an import.
 */

export type NotionRichText = { plain_text?: string; href?: string | null; annotations?: { code?: boolean } };
export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

function richText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as NotionRichText[])
    .map((p) => {
      const text = p.plain_text ?? "";
      if (!text) return "";
      if (p.annotations?.code) return `\`${text}\``;
      return p.href ? `[${text}](${p.href})` : text;
    })
    .join("");
}

function blockContent(block: NotionBlock): { text: string; checked?: boolean; language?: string } {
  const payload = block[block.type] as { rich_text?: unknown; checked?: boolean; language?: string } | undefined;
  return { text: richText(payload?.rich_text), checked: payload?.checked, language: payload?.language };
}

/**
 * Renders one level of blocks. `childrenOf` supplies a block's already-fetched
 * children (null when it has none), so pagination stays in the caller and this
 * stays synchronous and testable.
 */
export function blocksToMarkdown(
  blocks: NotionBlock[],
  childrenOf: (block: NotionBlock) => NotionBlock[] | null,
): string {
  const lines: string[] = [];
  let listIndex = 0;
  let lastWasNumbered = false;
  let lastWasListItem = false;

  const push = (line: string) => {
    lines.push(line);
  };

  for (const block of blocks) {
    const numbered = block.type === "numbered_list_item";
    const listItem = numbered || block.type === "bulleted_list_item" || block.type === "to_do" || block.type === "toggle";
    listIndex = numbered ? (lastWasNumbered ? listIndex + 1 : 1) : 0;
    lastWasNumbered = numbered;
    // A list after a heading or paragraph gets a blank line before it, so the
    // markdown parses as a list everywhere rather than leaning on the
    // "a 1. may interrupt a paragraph" rule.
    if (listItem && !lastWasListItem && lines.length > 0) push("");
    lastWasListItem = listItem;
    const { text, checked, language } = blockContent(block);
    const indent = (depth: number) => "  ".repeat(depth);

    const renderChildren = (depth: number) => {
      const children = childrenOf(block);
      if (children?.length) {
        const inner = blocksToMarkdown(children, childrenOf);
        for (const line of inner.replace(/\n+$/, "").split("\n")) push(line ? `${indent(depth)}${line}` : line);
      }
    };

    switch (block.type) {
      case "heading_1": push(`\n# ${text}`); break;
      case "heading_2": push(`\n## ${text}`); break;
      case "heading_3": push(`\n### ${text}`); break;
      case "paragraph": push(`\n${text}`); break;
      case "bulleted_list_item": push(`- ${text}`); renderChildren(1); break;
      case "numbered_list_item": push(`${listIndex}. ${text}`); renderChildren(1); break;
      case "to_do": push(`- [${checked ? "x" : " "}] ${text}`); renderChildren(1); break;
      case "toggle": push(`- ${text}`); renderChildren(1); break;
      case "quote": push(`> ${text}`); break;
      case "callout": push(`> ${text}`); renderChildren(1); break;
      case "code": push(`\n\`\`\`${language ?? ""}\n${text}\n\`\`\``); break;
      case "divider": push(`\n---`); break;
      case "child_page": {
        const title = (block.child_page as { title?: string } | undefined)?.title ?? "Untitled";
        push(`\n**Sub-page:** ${title} (notion://app/${block.id.replaceAll("-", "")})`);
        break;
      }
      case "child_database": {
        const title = (block.child_database as { title?: string } | undefined)?.title ?? "Untitled";
        push(`\n**Database:** ${title}`);
        break;
      }
      case "image":
      case "file":
      case "pdf":
      case "video": {
        const payload = block[block.type] as { type?: string; external?: { url?: string }; file?: { url?: string }; caption?: unknown } | undefined;
        const url = payload?.type === "external" ? payload.external?.url : payload?.file?.url;
        push(`\n[${block.type}: ${url ?? "attachment"}]`);
        break;
      }
      default:
        if (text) push(text);
        renderChildren(1);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** The page's properties line plus title, so a database row document still names its source fields. */
export function pageHeader(title: string, properties: Record<string, string>): string {
  const lines = Object.entries(properties)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`);
  return [`# ${title}`, "", ...lines, ""].join("\n");
}
