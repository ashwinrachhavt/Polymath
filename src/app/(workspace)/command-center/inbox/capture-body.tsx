"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { Button } from "@/components/ui/button";
import { updateCaptureTextAction } from "./actions";

/*
 * The captured body, rendered as Markdown through the same Tiptap stack the
 * note editor uses (StarterKit + Placeholder + Markdown, contentType
 * "markdown", immediatelyRender false so the first paint is the server's and
 * hydration does not re-create the document).
 *
 * Editing targets `captures.text`, the working body. The original that arrived
 * stays in `rawPayload` and no command touches it, so an edit clarifies what
 * the person is working on rather than rewriting what was captured. The
 * capture is editable only while it is unprocessed or classifying; once it
 * becomes a task or note the derived record owns the content and this surface
 * stays read-only.
 */
export function CaptureBody({
  captureId,
  version,
  text,
  label,
  editable,
}: {
  captureId: string;
  version: number;
  text: string;
  label: string;
  editable: boolean;
}) {
  const router = useRouter();
  // The row this surface last agreed with. A prop version newer than this is a
  // remote change and replaces the draft; this surface's own save moves the
  // base forward first, so its save never looks like one.
  const [base, setBase] = useState({ version, text });
  const [draft, setDraft] = useState(text);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  // One key per user intent; a retry after a dropped response replays instead
  // of writing twice.
  const intent = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), Placeholder.configure({ placeholder: "" }), Markdown],
    content: text,
    contentType: "markdown",
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        class:
          "max-w-[68ch] text-[14px] leading-7 outline-none [&_p]:mb-3 [&_h1]:mb-3 [&_h1]:text-xl [&_h2]:mb-2 [&_h2]:text-lg [&_h3]:mb-2 [&_h3]:text-base [&_ul]:mb-3 [&_ul]:list-disc [&_ol]:mb-3 [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_pre]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_a]:text-primary [&_a]:underline [&_hr]:my-4 [&_hr]:border-border",
      },
      handleKeyDown: (_view, event) => {
        if (editable && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          saveRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      setDraft(editor.getMarkdown());
      setStatus("idle");
      setError(null);
    },
  });

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // A newer row replaces the draft. Adjusting during render rather than in an
  // effect keeps the first paint of the new row from showing the old draft.
  if (base.version !== version) {
    setBase({ version, text });
    setDraft(text);
    setStatus("idle");
    setError(null);
  }

  // Push a replaced row into the editor. Not called for this surface's own
  // save, where the base already matches what the editor holds.
  useEffect(() => {
    if (editor && editor.getMarkdown() !== base.text) {
      editor.commands.setContent(base.text, { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, base.text]);

  const dirty = draft !== base.text;

  function save() {
    if (!editable || status === "saving" || !dirty) return;
    const key = (intent.current ??= crypto.randomUUID());
    setStatus("saving");
    setError(null);
    void updateCaptureTextAction({ captureId, expectedVersion: base.version, text: draft, idempotencyKey: key })
      .then((result) => {
        intent.current = null;
        if (result.ok) {
          // Move the base forward before the refreshed row arrives, so the
          // new version reads as this save rather than a remote change.
          setBase({ version: result.version, text: draft.trim() });
          setDraft(draft.trim());
          setStatus("saved");
          router.refresh();
          return;
        }
        setStatus("idle");
        setError(result.error);
      })
      .catch(() => {
        // Keep the key and the draft; the retry replays the same intent.
        setStatus("idle");
        setError("Could not reach the server. Try again.");
      });
  }
  useEffect(() => {
    saveRef.current = save;
  });

  return (
    <div className="flex flex-col gap-3">
      <EditorContent editor={editor} />

      {editable ? (
        <>
          <p className="max-w-[68ch] text-xs text-muted-foreground">
            The original capture is kept; this edits the working text.
          </p>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" disabled={!dirty || status === "saving"} onClick={save}>
              Save changes
            </Button>
            <span role="status" className="text-xs text-muted-foreground">
              {status === "saving" ? "Saving" : status === "saved" ? "Saved" : ""}
            </span>
          </div>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="max-w-[68ch] text-destructive text-[13px]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
