import { describe, expect, it } from "vitest";
import { blocksToMarkdown, pageHeader, type NotionBlock } from "@/integrations/notion/markdown";

/*
 * Synthetic fixtures in the shapes the owner's real workspace uses (nested
 * bullet groups under a heading, to-do lists, database-row property headers).
 * No real page text lives here.
 */

const rt = (text: string) => [{ plain_text: text }];

function block(id: string, type: string, text: string, extra?: Partial<NotionBlock>): NotionBlock {
  return { id, type, [type]: { rich_text: rt(text) }, ...extra };
}

describe("blocksToMarkdown", () => {
  it("renders a heading with a nested bullet group", () => {
    const child1 = block("c1", "bulleted_list_item", "Child one");
    const child2 = block("c2", "bulleted_list_item", "Child two");
    const parent = block("p1", "bulleted_list_item", "Parent topic", { has_children: true });
    const blocks: NotionBlock[] = [block("h", "heading_2", "Spec library"), parent, block("p2", "bulleted_list_item", "Sibling")];
    const children = new Map<string, NotionBlock[]>([[parent.id, [child1, child2]]]);
    const md = blocksToMarkdown(blocks, (b) => children.get(b.id) ?? null);
    expect(md).toBe("## Spec library\n\n- Parent topic\n  - Child one\n  - Child two\n- Sibling\n");
  });

  it("renders to-do blocks with their checked state", () => {
    const blocks: NotionBlock[] = [
      block("h", "heading_1", "Todo"),
      { id: "t1", type: "to_do", to_do: { rich_text: rt("Done thing"), checked: true } },
      { id: "t2", type: "to_do", to_do: { rich_text: rt("Open thing"), checked: false } },
    ];
    const md = blocksToMarkdown(blocks, () => null);
    expect(md).toBe("# Todo\n\n- [x] Done thing\n- [ ] Open thing\n");
  });

  it("numbers a numbered list sequentially and resets after it", () => {
    const blocks: NotionBlock[] = [
      block("n1", "numbered_list_item", "First"),
      block("n2", "numbered_list_item", "Second"),
      block("p", "paragraph", "Break"),
      block("n3", "numbered_list_item", "New list"),
    ];
    const md = blocksToMarkdown(blocks, () => null);
    expect(md).toBe("1. First\n2. Second\n\nBreak\n\n1. New list\n");
  });

  it("degrades an unknown block to its plain text instead of failing", () => {
    const blocks: NotionBlock[] = [{ id: "x", type: "synced_block", synced_block: { rich_text: rt("Exotic content") } }];
    expect(blocksToMarkdown(blocks, () => null)).toBe("Exotic content\n");
  });

  it("renders code fences, quotes and dividers", () => {
    const blocks: NotionBlock[] = [
      { id: "c", type: "code", code: { rich_text: rt("const a = 1;"), language: "ts" } },
      block("q", "quote", "A note"),
      { id: "d", type: "divider", divider: {} },
    ];
    const md = blocksToMarkdown(blocks, () => null);
    expect(md).toContain("```ts\nconst a = 1;\n```");
    expect(md).toContain("> A note");
    expect(md).toContain("---");
  });
});

describe("pageHeader", () => {
  it("lists database-row properties and skips empty ones", () => {
    const md = pageHeader("Polymath", { Name: "Polymath", Status: "Doing", Points: "1", Priority: "" });
    expect(md).toBe("# Polymath\n\n- Name: Polymath\n- Status: Doing\n- Points: 1\n");
  });
});
