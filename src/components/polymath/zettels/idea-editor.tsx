"use client";

import { useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { createSittingStore } from "./sitting-store";

/*
 * §14.11: the "New idea" direct flow - a single authored card with no
 * sitting. The draft persists under the workspace+`idea:new` key.
 */
export function IdeaEditor({ workspaceId }: { workspaceId: string }) {
  const store = useMemo(() => createSittingStore(workspaceId, "idea:new"), [workspaceId]);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder: "One idea, in your own words…" })],
    content: store.getState().draft || undefined,
    onUpdate: ({ editor }) => store.getState().setDraft(editor.getText()),
  });
  return (
    <div className="mx-auto max-w-2xl px-6 py-8 font-serif text-lg leading-relaxed">
      <h1 className="mb-4 font-sans text-sm font-medium text-muted-foreground">New idea</h1>
      <EditorContent editor={editor} />
    </div>
  );
}
