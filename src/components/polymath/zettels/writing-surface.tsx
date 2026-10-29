"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { CREATION_IDLE_MS } from "@/domains/knowledge/sittings";
import type { SittingEvent } from "@/domains/knowledge/sitting-events";
import {
  initialStreamState,
  reduceStreamEvent,
  type StreamState,
} from "./creation-stream-reducer";
import { createSittingStore, type SittingStore } from "./sitting-store";
import { saveSittingCardAction } from "@/app/(workspace)/polymath/knowledge/zettels/session/actions";
import { isFinalizeKey, suggestionKeyAction } from "./keyboard";

/*
 * The WritingSurface (§14.1-14.3): the writer types; CREATION_IDLE_MS after
 * they pause (with a non-empty draft ≥ 8 chars) the surface saves the draft
 * and opens the creation stream. Between idle and the first thinking event
 * the ambient panel shows "Reading your draft…" - silence never reads as
 * broken. The run's suggestion is a version-bound proposal: Enter keeps it
 * (one new authored version, §15.10), Escape discards it.
 */

const MIN_DRAFT_CHARS = 8;

export function WritingSurface({
  workspaceId,
  sittingId,
  seededFromDocument = false,
  onStreamState,
  onCardSaved,
}: {
  workspaceId: string;
  sittingId: string;
  /** §14.10: seeded sittings open with the one-line extract prompt, not an empty editor. */
  seededFromDocument?: boolean;
  onStreamState: (state: StreamState) => void;
  onCardSaved: (artifactId: string) => void;
}) {
  const store: SittingStore = useMemo(() => createSittingStore(workspaceId, sittingId), [workspaceId, sittingId]);
  const draft = store((s) => s.draft);
  const [streamState, setStreamState] = useState<StreamState>(() => initialStreamState(sittingId));
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifactVersion, setArtifactVersion] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionRef = useRef<HTMLDivElement | null>(null);
  const [suggestionFocused, setSuggestionFocused] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idemKey = useRef(`sitting-${sittingId}-${Date.now()}`);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder: seededFromDocument ? "Extract proposals from this document" : "Write the idea as it comes…" })],
    content: draft || undefined,
    onUpdate: ({ editor }) => {
      store.getState().setDraft(editor.getText());
      schedulePause();
    },
  });

  const apply = useCallback((event: SittingEvent) => {
    setStreamState((prev) => {
      const next = reduceStreamEvent(prev, event);
      onStreamState(next);
      if (event.event === "card_saved" && event.artifactId) onCardSaved(event.artifactId);
      return next;
    });
  }, [onStreamState, onCardSaved]);

  const firePause = useCallback(async () => {
    const text = store.getState().draft;
    if (text.trim().length < MIN_DRAFT_CHARS) return;
    setReading(true);
    setStreamState((prev) => ({ ...prev, done: false, live: { thinking: "", tokens: "" } }));
    const saved = await saveSittingCardAction({
      sittingId,
      artifactId: artifactId ?? undefined,
      expectedVersion: artifactVersion ?? undefined,
      idempotencyKey: idemKey.current,
      title: text.split("\n")[0]?.slice(0, 80) || "Untitled",
      content: editor?.getJSON() ?? { type: "doc", content: [] },
      plainText: text,
    });
    if ("error" in saved) {
      setReading(false);
      apply({ protocolVersion: 1, operationId: "", event: "error", payload: { code: saved.error, message: "The card could not be saved - your draft is still here." } });
      return;
    }
    setArtifactId(saved.artifactId);
    setArtifactVersion(saved.versionNumber);
    // §3: save-first, then the run. The stream drives the in-process run.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/v1/polymath/sittings/${sittingId}/create-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: saved.artifactId }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        setReading(false);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as SittingEvent;
            if (event.event === "thinking" || event.event === "token") setReading(false);
            apply(event);
          } catch {
            // A malformed line is skipped; the stream contract stays line-shaped.
          }
        }
      }
    } catch {
      // Aborted or dropped: durable events are the record; the next pause
      // reuses the open run (§16.9) or the sweep closes a stranded one (§16.1).
    } finally {
      setReading(false);
    }
  }, [apply, artifactId, artifactVersion, editor, sittingId, store]);

  const schedulePause = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    // §14.2: the debounce fires Track B exactly once per pause.
    idleTimer.current = setTimeout(() => { void firePause(); }, CREATION_IDLE_MS);
  }, [firePause]);

  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    abortRef.current?.abort();
  }, []);

  // §14.3: Enter keeps the proposal (one new authored version), Escape drops it.
  const adopt = useCallback(async (keep: boolean) => {
    const proposal = streamState.proposal;
    if (!proposal) return;
    setStreamState((prev) => ({ ...prev, proposal: null }));
    if (!keep || !editor || !artifactId || !artifactVersion) return;
    editor.commands.insertContent(`\n\n${proposal.suggestion}`);
    const saved = await saveSittingCardAction({
      sittingId,
      artifactId,
      expectedVersion: artifactVersion,
      idempotencyKey: `${idemKey.current}-adopt`,
      title: store.getState().draft.split("\n")[0]?.slice(0, 80) || "Untitled",
      content: editor.getJSON(),
      plainText: editor.getText(),
    });
    if (!("error" in saved)) setArtifactVersion(saved.versionNumber);
  }, [streamState.proposal, editor, artifactId, artifactVersion, sittingId, store]);

  useEffect(() => {
    // Focus tracking itself comes from onFocus/onBlur; when the proposal
    // clears, the key handler short-circuits on its absence anyway.
    if (streamState.proposal) suggestionRef.current?.focus();
  }, [streamState.proposal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // §14.13: Cmd/Ctrl+Enter finalizes the card - the pause fires now.
      if (isFinalizeKey(e) && !streamState.proposal) {
        e.preventDefault();
        if (idleTimer.current) clearTimeout(idleTimer.current);
        void firePause();
        return;
      }
      if (!streamState.proposal) return;
      // §14.3: plain Enter keeps, Escape discards - while the suggestion is focused.
      const action = suggestionKeyAction(e.key, suggestionFocused);
      if (action === "keep") { e.preventDefault(); void adopt(true); }
      if (action === "discard") { e.preventDefault(); void adopt(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [streamState.proposal, suggestionFocused, adopt, firePause]);

  const conflict = store((s) => s.conflict);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict && (
        <div role="alert" className="border-b border-border bg-muted/40 px-4 py-2 text-sm">
          Server has a newer saved version — compare / keep mine / take server.
          <button className="ml-3 underline" onClick={() => store.getState().resolveConflict("keep-mine")}>Keep mine</button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 font-serif text-lg leading-relaxed">
        <EditorContent editor={editor} />
      </div>
      {reading && <p className="px-6 pb-2 text-sm text-muted-foreground">Reading your draft…</p>}
      {streamState.proposal && (
        <div
          ref={suggestionRef}
          tabIndex={0}
          role="group"
          aria-label="AI suggestion"
          onFocus={() => setSuggestionFocused(true)}
          onBlur={() => setSuggestionFocused(false)}
          className="mx-6 mb-4 rounded-md border border-border bg-muted/30 p-3 text-sm italic text-muted-foreground outline-none ring-primary focus:ring-1"
        >
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">AI suggestion</span>
          <p className="whitespace-pre-wrap">{streamState.proposal.suggestion}</p>
          <span className="mt-2 flex items-center gap-2 not-italic">
            <button className="min-h-11 min-w-11 rounded-md bg-primary px-3 text-primary-foreground" onClick={() => void adopt(true)}>Keep</button>
            <button className="min-h-11 min-w-11 rounded-md border border-border px-3" onClick={() => void adopt(false)}>Discard</button>
            <span className="text-xs text-muted-foreground">Enter keeps · Esc discards</span>
          </span>
        </div>
      )}
    </div>
  );
}
