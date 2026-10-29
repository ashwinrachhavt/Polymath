"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { CREATION_IDLE_MS, DECOMPOSE_PASTE_CHARS } from "@/domains/knowledge/sitting-events";
import type { DecompositionAnalysis, DecompositionDecision } from "@/domains/knowledge/decomposition";
import {
  analyzePasteAction,
  commitDecompositionAction,
  saveSittingCardAction,
} from "@/app/(workspace)/polymath/knowledge/zettels/session/actions";
import { DecompositionPanel } from "./decomposition-panel";
import type { SittingEvent } from "@/domains/knowledge/sitting-events";
import {
  initialStreamState,
  reduceStreamEvent,
  type StreamState,
} from "./creation-stream-reducer";
import { createSittingStore, type SittingStore } from "./sitting-store";
import { createIdleDebouncer } from "./idle-debounce";
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
  initialWritingCard = null,
  onStreamState,
  onCardSaved,
}: {
  workspaceId: string;
  sittingId: string;
  /** Reopen hydration (§7): the sitting's saved working card. */
  initialWritingCard?: {
    artifactId: string;
    versionNumber: number;
    plainText: string;
    content: unknown;
    updatedAt: string;
  } | null;
  /** §14.10: seeded sittings open with the one-line extract prompt, not an empty editor. */
  seededFromDocument?: boolean;
  onStreamState: (state: StreamState) => void;
  onCardSaved: (artifactId: string) => void;
}) {
  const store: SittingStore = useMemo(() => createSittingStore(workspaceId, sittingId), [workspaceId, sittingId]);
  // The draft is read imperatively (store.getState()) everywhere except the
  // initial editor content: subscribing to it would re-render the whole
  // surface (and EditorContent) on every keystroke.
  const initialDraft = useRef(store.getState().draft);
  const [streamState, setStreamState] = useState<StreamState>(() => initialStreamState(sittingId));
  const [artifactId, setArtifactId] = useState<string | null>(initialWritingCard?.artifactId ?? null);
  const [artifactVersion, setArtifactVersion] = useState<number | null>(initialWritingCard?.versionNumber ?? null);
  const [reading, setReading] = useState(false);
  // §14.4 conflict: the server saved a newer version than our base. The
  // writer compares, keeps theirs, or takes the server's - never a clobber.
  const [conflict, setConflict] = useState<{ serverPlainText: string; serverVersion: number; serverUpdatedAt: string } | null>(null);
  const [comparing, setComparing] = useState(false);
  const suggestionRef = useRef<HTMLDivElement | null>(null);
  const [suggestionFocused, setSuggestionFocused] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const idemKey = useRef(`sitting-${sittingId}-${Date.now()}`);
  // Every save/adopt intent gets its own idempotency key: a shared key makes
  // a later pause conflict with the earlier one's receipt and silently drops
  // the draft's save.
  const saveSeq = useRef(0);
  const adoptSeq = useRef(0);
  /*
   * §14.6 decomposition review: a large paste keeps its text in the editor
   * (original untouched, §4) while analysis proposes extractions. Analysis
   * writes nothing; canceling the banner just stops watching - there is
   * nothing server-side to undo.
   */
  const [decomp, setDecomp] = useState<
    | { status: "analyzing" }
    | { status: "review"; analysis: DecompositionAnalysis }
    | { status: "failed"; message: string; text: string }
    | null
  >(null);
  const [committing, setCommitting] = useState(false);
  const [decompNote, setDecompNote] = useState<string | null>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit, Placeholder.configure({ placeholder: seededFromDocument ? "Extract proposals from this document" : "Write the idea as it comes…" })],
    content: initialDraft.current || undefined,
    editorProps: {
      handlePaste: (_view, event) => {
        // Never preventDefault: the original paste always lands (§4). Over
        // the threshold we additionally offer extraction review.
        const pasted = event.clipboardData?.getData("text/plain");
        if (pasted && pasted.length >= DECOMPOSE_PASTE_CHARS) {
          setTimeout(() => void runAnalysis(pasted), 0);
        }
        return false;
      },
    },
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

  // §7/§14.4 reopen hydration: reconcile the local draft with the sitting's
  // saved card (updatedAt-wins; a both-moved state surfaces the conflict UI,
  // never a silent clobber). Runs once the editor exists.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current || !editor || !initialWritingCard) return;
    hydratedRef.current = true;
    const result = store.getState().reconcileWithServer({
      content: initialWritingCard.plainText,
      updatedAt: new Date(initialWritingCard.updatedAt).getTime(),
    });
    if (result === "adopted") editor.commands.setContent(initialWritingCard.content as never);
    if (result === "conflict") {
      // Deferred out of the effect body: the conflict UI re-renders on the
      // next tick instead of cascading inside hydration.
      const card = initialWritingCard;
      queueMicrotask(() =>
        setConflict({
          serverPlainText: card.plainText,
          serverVersion: card.versionNumber,
          serverUpdatedAt: card.updatedAt,
        }),
      );
    }
  }, [editor, initialWritingCard, store]);

  const firePause = useCallback(async () => {
    const text = store.getState().draft;
    if (text.trim().length < MIN_DRAFT_CHARS) return;
    // A new pause supersedes a stream still attached to the previous one:
    // abort it first so the reducer's operation guard drops its late events,
    // then reset the stream identity - a stale operationId would make the
    // reducer discard the NEW run's events.
    abortRef.current?.abort();
    setStreamState(initialStreamState(sittingId));
    setReading(true);
    saveSeq.current += 1;
    let saved: Awaited<ReturnType<typeof saveSittingCardAction>>;
    try {
      saved = await saveSittingCardAction({
        sittingId,
        artifactId: artifactId ?? undefined,
        expectedVersion: artifactVersion ?? undefined,
        idempotencyKey: `${idemKey.current}-save-${saveSeq.current}`,
        title: text.split("\n")[0]?.slice(0, 80) || "Untitled",
        content: editor?.getJSON() ?? { type: "doc", content: [] },
        plainText: text,
      });
    } catch {
      // A thrown save (network, server failure) must not wedge the surface
      // in the reading state: surface it as an error and let the next pause
      // retry with a fresh intent key.
      setReading(false);
      apply({ protocolVersion: 1, operationId: "", event: "error", payload: { code: "save_failed", message: "The card could not be saved - your draft is still here." } });
      return;
    }
    if ("error" in saved) {
      setReading(false);
      if (saved.error === "version_conflict") {
        setConflict({ serverPlainText: saved.server.plainText, serverVersion: saved.server.version, serverUpdatedAt: saved.server.updatedAt });
        return;
      }
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

  const runAnalysis = useCallback(async (text: string) => {
    setDecomp({ status: "analyzing" });
    setDecompNote(null);
    const result = await analyzePasteAction({ text });
    if ("error" in result) {
      setDecomp({ status: "failed", message: result.message, text });
      return;
    }
    if (result.analysis.candidates.length === 0 && result.analysis.omitted.length === 0) {
      setDecomp(null);
      setDecompNote("No extractable structure found - your text stays as-is.");
      return;
    }
    setDecomp({ status: "review", analysis: result.analysis });
  }, []);

  const commitDecisions = useCallback(async (analysis: DecompositionAnalysis, decisions: DecompositionDecision[]) => {
    setCommitting(true);
    const result = await commitDecompositionAction({ analysis, decisions, idempotencyKey: `${idemKey.current}-decomp`, sittingId });
    setCommitting(false);
    if ("error" in result) {
      setDecompNote(result.message);
      return;
    }
    const parts: string[] = [];
    if (result.created.length) parts.push(`${result.created.length} created`);
    if (result.merged.length) parts.push(`${result.merged.length} merged`);
    if (result.linked.length) parts.push(`${result.linked.length} linked`);
    if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
    setDecomp(null);
    setDecompNote(parts.length ? `Committed: ${parts.join(", ")}.` : "Nothing committed.");
  }, [sittingId]);

  // §14.2: the debounce fires Track B exactly once per pause. The ref keeps
  // every fire on the latest firePause without re-arming a pending pause.
  const firePauseRef = useRef(firePause);
  firePauseRef.current = firePause;
  const pauseDebounce = useMemo(() => createIdleDebouncer(() => { void firePauseRef.current(); }, CREATION_IDLE_MS), []);
  const schedulePause = pauseDebounce.signal;

  useEffect(() => () => {
    pauseDebounce.cancel();
    abortRef.current?.abort();
  }, [pauseDebounce]);

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
      idempotencyKey: `${idemKey.current}-adopt-${(adoptSeq.current += 1)}`,
      title: store.getState().draft.split("\n")[0]?.slice(0, 80) || "Untitled",
      content: editor.getJSON(),
      plainText: editor.getText(),
    });
    if ("error" in saved) {
      if (saved.error === "version_conflict") setConflict({ serverPlainText: saved.server.plainText, serverVersion: saved.server.version, serverUpdatedAt: saved.server.updatedAt });
    } else {
      setArtifactVersion(saved.versionNumber);
    }
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
        pauseDebounce.cancel();
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
  }, [streamState.proposal, suggestionFocused, adopt, firePause, pauseDebounce]);

  // §14.4: keep mine = save my text as a new version on top of the server's;
  // take server = adopt the server's text and version as my base.
  const keepMine = useCallback(async () => {
    if (!conflict || !artifactId || !editor) return;
    const saved = await saveSittingCardAction({
      sittingId,
      artifactId,
      expectedVersion: conflict.serverVersion,
      idempotencyKey: `${idemKey.current}-keep-mine`,
      title: store.getState().draft.split("\n")[0]?.slice(0, 80) || "Untitled",
      content: editor.getJSON(),
      plainText: editor.getText(),
    });
    if ("error" in saved) {
      if (saved.error === "version_conflict") setConflict({ serverPlainText: saved.server.plainText, serverVersion: saved.server.version, serverUpdatedAt: saved.server.updatedAt }); // moved again: compare against the newer base
      return;
    }
    setArtifactVersion(saved.versionNumber);
    setConflict(null);
    setComparing(false);
  }, [conflict, artifactId, editor, sittingId, store]);

  const takeServer = useCallback(() => {
    if (!conflict || !editor) return;
    editor.commands.setContent(conflict.serverPlainText);
    store.getState().setDraft(conflict.serverPlainText);
    setArtifactVersion(conflict.serverVersion);
    setConflict(null);
    setComparing(false);
  }, [conflict, editor, store]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {conflict && (
        <div role="alert" className="border-b border-border bg-muted/40 px-4 py-2 text-sm">
          <span className="flex flex-wrap items-center gap-2">
            The server has a newer saved version of this card.
            <button className="min-h-11 px-2 underline" onClick={() => setComparing((c) => !c)}>{comparing ? "Hide comparison" : "Compare"}</button>
            <button className="min-h-11 px-2 underline" onClick={() => void keepMine()}>Keep mine</button>
            <button className="min-h-11 px-2 underline" onClick={takeServer}>Take server</button>
          </span>
          {comparing && (
            <span className="mt-2 grid grid-cols-2 gap-3 max-lg:grid-cols-1">
              <span className="block rounded border border-border p-2">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Saved on the server (v{conflict.serverVersion})</span>
                <span className="block whitespace-pre-wrap">{conflict.serverPlainText}</span>
              </span>
              <span className="block rounded border border-border p-2">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Your draft</span>
                <span className="block whitespace-pre-wrap">{store.getState().draft}</span>
              </span>
            </span>
          )}
        </div>
      )}
      {decomp?.status === "analyzing" && (
        <div role="status" className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2 text-sm">
          <span>Analyzing paste - review proposed extractions</span>
          <button className="min-h-11 px-2 underline" onClick={() => setDecomp(null)}>Cancel</button>
        </div>
      )}
      {decomp?.status === "failed" && (
        <div role="alert" className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2 text-sm">
          <span className="text-destructive">{decomp.message}</span>
          <span className="flex gap-2">
            <button className="min-h-11 px-2 underline" onClick={() => void runAnalysis(decomp.text)}>Retry</button>
            <button className="min-h-11 px-2 underline" onClick={() => setDecomp(null)}>Dismiss</button>
          </span>
        </div>
      )}
      {decompNote && !decomp && (
        <div role="status" className="flex items-center justify-between border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
          <span>{decompNote}</span>
          <button className="min-h-11 px-2 underline" onClick={() => setDecompNote(null)}>OK</button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 font-serif text-lg leading-relaxed">
          <EditorContent editor={editor} />
        </div>
        {decomp?.status === "review" && (
          <DecompositionPanel
            analysis={decomp.analysis}
            committing={committing}
            onCommit={(decisions) => void commitDecisions(decomp.analysis, decisions)}
            onDismiss={() => setDecomp(null)}
          />
        )}
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
