"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";

/*
 * The captured body, rendered as Markdown through the same Tiptap stack the
 * note editor uses (StarterKit + Placeholder + Markdown, contentType
 * "markdown", immediatelyRender false so the first paint is the server's and
 * hydration does not re-create the document).
 *
 * Read-only for now: the capture domain has no update-text command and its
 * schema comment calls `captures.text` the original, immutable record
 * (src/domains/capture/schema.ts), so this pane must not invite edits the
 * server would refuse. The editing surface lands with that command, not
 * before it.
 */
export function CaptureBody({ text, label }: { text: string; label: string }) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), Placeholder.configure({ placeholder: "" }), Markdown],
    content: text,
    contentType: "markdown",
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "document",
        "aria-label": label,
        class:
          "max-w-[68ch] text-[14px] leading-7 outline-none [&_p]:mb-3 [&_h1]:mb-3 [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:text-lg [&_h3]:mb-2 [&_h3]:text-base [&_ul]:mb-3 [&_ul]:list-disc [&_ol]:mb-3 [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_pre]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_a]:text-primary [&_a]:underline [&_hr]:my-4 [&_hr]:border-border",
      },
    },
  });

  return <EditorContent editor={editor} />;
}
