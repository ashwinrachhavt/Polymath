"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { createSittingStore } from "./sitting-store";
import { createIdleDebouncer } from "./idle-debounce";
import { CREATION_IDLE_MS } from "@/domains/knowledge/sitting-events";
import { saveIdeaAction } from "@/app/(workspace)/polymath/knowledge/ideas/actions";

/*
 * §14.11: the "New idea" direct flow - a single authored card with no
 * sitting. The draft persists under the workspace+`idea:new` key as HTML so
 * a multi-paragraph note round-trips; every pause saves through the same
 * receipt-keyed, version-claimed machinery a sitting's Keep uses, and the
 * saved card id persists in the store so a reopen keeps editing that card
 * instead of creating a duplicate.
 */
export function IdeaEditor({ workspaceId }: { workspaceId: string }) {
  const store = useMemo(() => createSittingStore(workspaceId, "idea:new"), [workspaceId]);
  const idemBase = useRef<string | null>(null);
  const saveSeq = useRef(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [conflict, setConflict] = useState<{ plainText: string; updatedAt: string } | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const plainText = editor.getText();
    if (!plainText.trim()) return;
    if (!idemBase.current) idemBase.current = crypto.randomUUID();
    saveSeq.current += 1;
    const key = `${idemBase.current}-save-${saveSeq.current}`;
    const { savedArtifactId, savedVersion } = store.getState();
    setSaveState("saving");
    const title = plainText.split("\n").find((line) => line.trim())?.trim().slice(0, 80) ?? "";
    const result = await saveIdeaAction({
      idempotencyKey: key,
      artifactId: savedArtifactId ?? undefined,
      expectedVersion: savedVersion ?? undefined,
      title,
      content: editor.getJSON(),
      plainText,
    });
    if ("error" in result) {
      if (result.error === "version_conflict" && result.server) {
        // §14.4: never a silent clobber - surface it and let the writer pick.
        setConflict({ plainText: result.server.plainText, updatedAt: result.server.updatedAt });
        setSaveState("idle");
        return;
      }
      setSaveState("error");
      return;
    }
    store.getState().setSavedCard(result.artifactId, result.versionNumber);
    setSaveState("saved");
  }, [store]);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const debouncerRef = useRef<ReturnType<typeof createIdleDebouncer> | null>(null);
  useEffect(() => {
    const debouncer = createIdleDebouncer(() => { void saveRef.current(); }, CREATION_IDLE_MS);
    debouncerRef.current = debouncer;
    return () => debouncer.cancel();
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder: "One idea, in your own words…" })],
    content: store.getState().draft || undefined,
    onUpdate: ({ editor }) => {
      store.getState().setDraft(editor.getHTML());
      debouncerRef.current?.signal();
    },
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 font-serif text-lg leading-relaxed">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="font-sans text-sm font-medium text-muted-foreground">New idea</h1>
        <span className="font-sans text-xs text-muted-foreground">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed - keeps retrying on edit" : ""}
        </span>
      </div>
      {conflict ? (
        <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 font-sans text-sm">
          <p>A newer saved copy exists (saved {new Date(conflict.updatedAt).toLocaleString()}).</p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded border px-2 py-1"
              onClick={() => {
                setConflict(null);
                void saveRef.current();
              }}
            >
              Keep mine
            </button>
            <button
              className="rounded border px-2 py-1"
              onClick={() => {
                editorRef.current?.commands.setContent(conflict.plainText);
                store.getState().setDraft(conflict.plainText);
                setConflict(null);
              }}
            >
              Take saved copy
            </button>
          </div>
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
