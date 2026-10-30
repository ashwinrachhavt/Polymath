"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Content } from "@tiptap/react";
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
 *
 * The same component edits an idea that already exists: passing `artifactId`
 * and `version` opens that card under its own draft key and primes the store
 * with its saved id, so the first pause claims the version it was given
 * rather than creating a second card.
 */
export function IdeaEditor({
  workspaceId,
  artifactId,
  version,
  initialContent,
  label = "New idea",
}: {
  workspaceId: string;
  /** The idea being edited; omitted in the new-idea flow. */
  artifactId?: string;
  /** The version the editor was opened at - the base for its first claim. */
  version?: number;
  /** Existing body to open with; the local draft still wins when one is newer. */
  initialContent?: unknown;
  /** Heading text, or null when the surrounding page already says it. */
  label?: string | null;
}) {
  const storeKey = artifactId ?? "idea:new";
  const store = useMemo(() => createSittingStore(workspaceId, storeKey), [workspaceId, storeKey]);
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
      artifactId: savedArtifactId ?? artifactId,
      // The opened version is the base until a save returns a newer one; a
      // store with an id but no version still claims the page's version
      // rather than falling through to a create.
      expectedVersion: (savedArtifactId ? savedVersion : undefined) ?? version,
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
  }, [store, artifactId, version]);
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

  // Editing an existing idea: the store carries the id and version this card
  // was opened at, so the first pause saves a new version of it rather than
  // creating a second card. A local draft, if one was persisted, still wins.
  useEffect(() => {
    if (!artifactId || !version) return;
    const { savedArtifactId } = store.getState();
    if (!savedArtifactId) store.getState().setSavedCard(artifactId, version);
  }, [store, artifactId, version]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder: "One idea, in your own words…" })],
    content: (store.getState().draft || initialContent || undefined) as Content | undefined,
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
        {label ? <h1 className="font-sans text-sm font-medium text-muted-foreground">{label}</h1> : <span />}
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
