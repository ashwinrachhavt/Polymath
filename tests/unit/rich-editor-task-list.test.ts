// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { richEditorMarkdown } from "@/components/products/polymath/markdown-preservation";

/*
 * The note editor used to lock any note with `- [ ]` into a raw source
 * textarea because StarterKit had no task list. These pin the round trip the
 * rich editor now relies on: checkboxes parse into task items and serialize
 * back to the same Markdown, checked state included.
 */
const editors: Editor[] = [];
const make = (content: string) => {
  const editor = new Editor({
    extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Markdown],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
};
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

describe("rich editor task lists", () => {
  it("parses checkboxes into task items with their checked state", () => {
    const editor = make("- [ ] todo\n- [x] done");
    const items: boolean[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "taskItem") items.push(node.attrs.checked);
    });
    expect(items).toEqual([false, true]);
  });

  it("serializes back to the same Markdown", () => {
    const markdown = "Intro\n\n- [ ] todo\n- [x] done\n\nAfter";
    expect(make(markdown).getMarkdown().trim()).toBe(markdown);
  });

  it("keeps a toggled checkbox", () => {
    const editor = make("- [ ] todo");
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === "taskItem") pos = at;
    });
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { checked: true }));
    expect(editor.getMarkdown().trim()).toBe("- [x] todo");
  });
});

/*
 * StarterKit's TrailingNode appends an empty paragraph after a final list,
 * quote or code block on the first transaction after mount (the editor's
 * link-preview refresh is one). Serialized raw, that added "\n\n" and an
 * untouched note autosaved changed text.
 */
describe("rich editor note text", () => {
  it.each([
    "- venue shortlist\n- invite list",
    "- [ ] todo\n- [x] done",
    "1. one\n2. two",
    "> quote",
    "```\ncode\n```",
    "Intro\n\n- item",
  ])("an untouched note keeps its text: %j", (markdown) => {
    const editor = make(markdown);
    const updates: string[] = [];
    editor.on("update", () => updates.push(richEditorMarkdown(editor.getMarkdown())));
    editor.view.dispatch(editor.state.tr.setMeta("refresh", true));
    expect(updates.every((text) => text === markdown)).toBe(true);
    expect(richEditorMarkdown(editor.getMarkdown())).toBe(markdown);
  });
});
