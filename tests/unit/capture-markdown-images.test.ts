// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { afterEach, describe, expect, it } from "vitest";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("capture Markdown images", () => {
  it("renders a captured image in the Inbox body editor", () => {
    editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, Image.configure({ allowBase64: false }), Markdown],
      content: "![Clipboard image](/api/v1/captures/capture-1/file)",
      contentType: "markdown",
    });

    expect(editor.getHTML()).toContain('<img src="/api/v1/captures/capture-1/file"');
    expect(editor.getHTML()).toContain('alt="Clipboard image"');
  });
});
