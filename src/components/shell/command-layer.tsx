"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  FileText,
  Inbox,
  Keyboard,
  ListTodo,
  Mic,
  Paperclip,
  Plus,
  Search,
  Square,
  Users,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DictationButton } from "@/components/speech/dictation-button";
import { destinations } from "@/lib/navigation";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ImportDrop } from "@/components/workspace/import-drop";
import { MAX_UPLOAD_LABEL } from "@/lib/file-validation";
import { uploadCaptureFile } from "@/lib/capture-upload";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { snapshotCaptureContext, type CaptureSnapshot } from "./capture-context";
import type { CaptureContext } from "@/domains/capture/context";
import { mergePaletteResults } from "./palette-merge";
import {
  quickCapture,
  refreshInbox,
  searchWorkspace,
  searchWorkspaceKnowledge,
  type WorkspaceKnowledgeResult,
  type WorkspaceRecord,
} from "./shell-actions";

const subscribeToHydration = () => () => {};

export function CommandLayer({
  initialMode = null,
  withTriggers = true,
  onOpenChange,
}: {
  initialMode?: "search" | "capture" | null;
  withTriggers?: boolean;
  /** Opens/closes relayed to the host — the mount unmounts the layer on close. */
  onOpenChange?: (open: boolean) => void;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const { notify } = useWorkspace();
  const router = useRouter();
  const [mode, setMode] = useState<"search" | "capture" | null>(initialMode ?? null);
  const [query, setQuery] = useState("");
  // Opened straight into Capture, a selection made beforehand becomes the words.
  const [text, setText] = useState(() =>
    initialMode === "capture" && typeof window !== "undefined" ? (snapshotCaptureContext().passage ?? "") : "",
  );
  const [saveError, setSaveError] = useState("");
  const [saveErrorId, setSaveErrorId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  // The palette's second phase: knowledge cards the hybrid engine ranks by
  // body text and meaning, streamed in behind the title matches.
  const [knowledgeRecords, setKnowledgeRecords] = useState<WorkspaceRecord[]>([]);
  const [meaningState, setMeaningState] = useState<WorkspaceKnowledgeResult["meaning"] | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState(0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const captureTrigger = useRef<HTMLButtonElement>(null);
  // One sequence id per debounce fire: only the newest query may write search
  // state, whichever phase lands last.
  const searchSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filePending, setFilePending] = useState(false);
  // Voice notes record straight into the same dialog (ASH-314): one entry
  // point, whatever the material. The recorder lives in a ref so the dialog
  // closing always stops the mic; `recording` only re-renders the controls.
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const returnTo = useRef<"search" | "capture">(initialMode ?? "search");
  // Where the capture came from, read at the moment Capture opens (see
  // capture-context.ts), and the optional answer to why it matters.
  const [snapshot, setSnapshot] = useState<CaptureSnapshot | null>(() =>
    initialMode === "capture" && typeof window !== "undefined" ? snapshotCaptureContext() : null,
  );
  const [why, setWhy] = useState<NonNullable<CaptureContext["why"]> | null>(null);
  const whyInput = useRef<HTMLInputElement>(null);

  function beginCapture() {
    const next = snapshotCaptureContext();
    setSnapshot(next);
    setWhy(null);
    if (next.passage) setText((current) => current || next.passage || "");
  }

  function open(next: "search" | "capture") {
    if (next === "capture") beginCapture();
    returnTo.current = next;
    setQuery("");
    setSelected(0);
    setKnowledgeRecords([]);
    setMeaningState(null);
    setMode(next);
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        returnTo.current = "search";
        setQuery("");
        setSelected(0);
        setMode((current) => (current === "search" ? null : "search"));
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        returnTo.current = "capture";
        beginCapture();
        setMode("capture");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const navigation = destinations.map((destination) => ({
    key: destination.href,
    label: destination.label,
    context: destination.group === "shared" ? "Shared workspace" : "Polymath",
    icon: destination.icon,
    href: destination.href,
  }));
  // Canonical record search: debounced server query over saved tasks, notes,
  // people, and inbox items - the rows every other surface reads. The second
  // phase streams in the knowledge cards behind them (the notes page's
  // pattern: keyword renders first, the fused ranking arrives once the query
  // has been embedded). No provider key means the second phase answers
  // keyword-only and says so; the palette never errors for want of a key.
  const search = query.trim();
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.length < 2) {
        setRecords([]);
        setKnowledgeRecords([]);
        setMeaningState(null);
        setSearched(false);
        return;
      }
      const seq = ++searchSeq.current;
      void searchWorkspace(search)
        .then((found) => {
          if (searchSeq.current === seq) {
            setRecords(found);
            setSearched(true);
          }
        })
        .catch(() => {
          if (searchSeq.current === seq) {
            setRecords([]);
            setSearched(true);
          }
        });
      void searchWorkspaceKnowledge(search)
        .then((found) => {
          if (searchSeq.current === seq) {
            setKnowledgeRecords(found.records);
            setMeaningState(found.meaning);
          }
        })
        .catch(() => {
          if (searchSeq.current === seq) {
            setKnowledgeRecords([]);
            setMeaningState(null);
          }
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const toRow = (record: WorkspaceRecord) => ({
    key: record.id,
    label: record.label,
    context: record.context,
    icon:
      record.kind === "task"
        ? ListTodo
        : record.kind === "contact"
          ? Users
          : record.kind === "inbox"
            ? Inbox
            : FileText,
    href: record.href,
  });
  // Title matches keep their tiered order; knowledge cards the meaning leg
  // surfaced append in fused rank, minus anything the titles already found.
  const recordResults = mergePaletteResults(records.map(toRow), knowledgeRecords.map(toRow));
  const navMatches = search
    ? navigation.filter((result) => `${result.label} ${result.context}`.toLowerCase().includes(search.toLowerCase()))
    : navigation;
  const matches = search ? [...recordResults, ...navMatches] : navigation;
  const results = matches.slice(0, 20);
  const active = Math.min(selected, Math.max(0, results.length - 1));
  // Degraded-mode honesty (the notes page's wording): the meaning leg could
  // not run, so what is showing is keyword matches only.
  const meaningNote =
    meaningState && meaningState !== "ok" && matches.length > 0
      ? " Showing keyword matches only. Meaning search is not available right now."
      : "";

  function navigate(href: string) {
    setMode(null);
    router.push(href);
  }
  // Files and screenshots capture through the multipart API route (server
  // actions cap below the 4.5 MB function ceiling), then the cached inbox is
  // refreshed so the new row is there when the dialog lands on it.
  function attachFile(file: File) {
    if (filePending || pending) return;
    setSaveError("");
    setSaveErrorId(null);
    setFilePending(true);
    void uploadCaptureFile(file)
      .then(async (result) => {
        if (!result.ok) {
          setSaveError(result.message);
          return;
        }
        await refreshInbox();
        notify(
          result.quarantined ? `Captured ${file.name} - type not recognized, stored as-is.` : `Captured ${file.name}.`,
        );
        setText("");
        setMode(null);
        navigate(`/command-center/inbox?id=${result.captureId}`);
      })
      .finally(() => setFilePending(false));
  }
  function saveCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || pending) return;
    setSaveError("");
    setSaveErrorId(null);
    setPending(true);
    // A selection the person replaced with their own words is still the
    // passage they were looking at, so it is kept either way.
    const context: CaptureContext = { ...snapshot?.context, ...(why ? { why } : {}) };
    void quickCapture(text, crypto.randomUUID(), context)
      .then((result) => {
        if (!result.ok) {
          setSaveError(result.error);
          setSaveErrorId(result.existingId ?? null);
          return;
        }
        notify(result.message);
        setText("");
        setWhy(null);
        setSnapshot(null);
        setMode(null);
      })
      .catch(() => setSaveError("Could not save. Try again."))
      .finally(() => setPending(false));
  }

  // A pasted screenshot or dropped-in image is a capture too: the paste never
  // becomes text first, it uploads through the same sniffed file route.
  function pasteCapture(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(event.clipboardData?.files ?? [])[0];
    if (!file) return;
    event.preventDefault();
    attachFile(file);
  }

  // One mic button: tap to start, tap to stop and capture. The recording
  // uploads like any other file; content sniffing marks it a voice capture.
  function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setSaveError("");
    setSaveErrorId(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSaveError("This browser cannot record audio. Type or attach a file instead.");
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
        const session = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        session.addEventListener("dataavailable", (event) => {
          if (event.data.size) chunks.push(event.data);
        });
        session.addEventListener("stop", () => {
          stream.getTracks().forEach((track) => track.stop());
          recorder.current = null;
          setRecording(false);
          if (!chunks.length) return;
          const type = session.mimeType || "audio/webm";
          const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
          attachFile(new File(chunks, `voice-note.${extension}`, { type }));
        });
        recorder.current = session;
        session.start();
        setRecording(true);
      })
      .catch(() => setSaveError("Microphone access was refused. Type or attach a file instead."));
  }

  // The mic never outlives the dialog: closing or switching modes stops it.
  useEffect(() => {
    if (mode === null && recorder.current) recorder.current.stop();
  }, [mode]);

  // Triggerless mount: the wrapper in command-layer-mount.tsx owns the
  // triggers, so a palette loaded from it renders the dialog alone. The
  // trigger refs stay null then; focus restore falls back to the
  // [data-search-trigger] lookup, which finds the wrapper button.
  return (
    <>
      {withTriggers && (
        <>
          <span className="contents md:hidden">
            <button
              ref={searchTrigger}
              type="button"
              disabled={!hydrated}
              onClick={() => open("search")}
              aria-label="Search workspace"
              aria-keyshortcuts="Meta+K Control+K"
              data-search-trigger
              className="global-search disabled:opacity-50"
            >
              <Search aria-hidden className="size-4 shrink-0" />
              <span className="hidden lg:inline">Search your workspace</span>
            </button>
          </span>
          <Button
            ref={captureTrigger}
            size="sm"
            disabled={!hydrated}
            onClick={() => open("capture")}
            aria-keyshortcuts="Meta+Shift+C Control+Shift+C"
          >
            <Plus aria-hidden />
            <span className="hidden sm:inline">Capture</span>
            <span className="sr-only sm:hidden">Capture</span>
          </Button>
        </>
      )}
      <Dialog
        open={mode !== null}
        onOpenChange={(value) => {
          if (!value) setMode(null);
          onOpenChange?.(value);
        }}
      >
        <DialogContent
          className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnTo.current === "capture") {
              // withTriggers={false} (the mount hosts the triggers): fall back
              // to the persistent external trigger's marker.
              const externalCapture = document.querySelector<HTMLElement>("[data-capture-trigger]");
              (captureTrigger.current ?? externalCapture)?.focus();
              return;
            }
            const triggers = Array.from(document.querySelectorAll<HTMLElement>("[data-search-trigger]"));
            (triggers.find((el) => el.offsetParent !== null) ?? searchTrigger.current)?.focus();
          }}
        >
          <DialogTitle>{mode === "search" ? "Search and commands" : "Capture"}</DialogTitle>
          <DialogDescription>
            {mode === "search"
              ? "Navigate anywhere, or find saved tasks, notes, people, knowledge cards and inbox items. Documents use the search in Polymath Knowledge."
              : "Everything lands in the inbox first. Polymath reads it and suggests what it becomes - you only ever capture."}
          </DialogDescription>
          {mode === "search" ? (
            <>
              <Input
                key="search"
                autoFocus
                className="h-11 border-transparent bg-muted/60 text-body focus-visible:ring-1"
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-label="Search workspace"
                value={query}
                placeholder="Search tasks, notes, people and destinations"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSelected(Math.min(active + 1, results.length - 1));
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSelected(Math.max(active - 1, 0));
                  }
                  if (event.key === "Enter" && results[active]) {
                    event.preventDefault();
                    navigate(results[active].href);
                  }
                }}
                aria-controls="command-results"
                aria-activedescendant={results[active] ? `command-${active}` : undefined}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 justify-start"
                  onClick={() => {
                    beginCapture();
                    setMode("capture");
                  }}
                >
                  <Plus aria-hidden />
                  Capture something<span className="readout ml-auto text-data">Ctrl/⌘ Shift C</span>
                </Button>
                {/* The header stays quiet: the shortcuts list lives here, on the
                keyboard surface, instead of a sixth header control. Shift+?
                still opens it from anywhere. */}
                <ShortcutsDialog
                  trigger={
                    <Button variant="outline" aria-label="Keyboard shortcuts">
                      <Keyboard aria-hidden />
                      <span className="hidden sm:inline">Shortcuts</span>
                      <span className="readout ml-auto hidden text-data sm:inline">Shift ?</span>
                    </Button>
                  }
                />
              </div>
              <div
                id="command-results"
                role="listbox"
                aria-label="Search results"
                className="max-h-[45dvh] overflow-y-auto"
              >
                {results.map((result, index) => (
                  <button
                    key={result.key}
                    id={`command-${index}`}
                    role="option"
                    aria-selected={active === index}
                    type="button"
                    onClick={() => navigate(result.href)}
                    onMouseEnter={() => setSelected(index)}
                    className="command-result"
                  >
                    <result.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="max-w-full truncate">{result.label}</span>
                      <span className="text-data text-muted-foreground">{result.context}</span>
                    </span>
                    <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
              <p role="status" className="text-xs text-muted-foreground">
                {matches.length === 0
                  ? search && !searched
                    ? "Searching…"
                    : "No results. Capture a new item or try a different search."
                  : matches.length > results.length
                    ? `Showing ${results.length} of ${matches.length} matches. Refine your search for more.${meaningNote}`
                    : `${matches.length} ${matches.length === 1 ? "result" : "results"}.${meaningNote}`}
              </p>
            </>
          ) : (
            <>
              <form id="quick-capture-form" onSubmit={saveCapture} className="flex flex-col gap-4">
                <label className="flex flex-col gap-2 text-body-dense font-medium">
                  Anything worth keeping
                  <Textarea
                    key="capture"
                    autoFocus
                    required
                    rows={4}
                    maxLength={10000}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onPaste={pasteCapture}
                    placeholder="A thought, a task, a link, a pasted screenshot"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInput}
                    type="file"
                    className="hidden"
                    aria-hidden
                    tabIndex={-1}
                    onChange={(event) => {
                      const chosen = event.target.files?.[0];
                      event.target.value = "";
                      if (chosen) attachFile(chosen);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={filePending || pending || recording}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip aria-hidden />
                    {filePending ? "Capturing…" : "Attach file"}
                  </Button>
                  <Button
                    type="button"
                    variant={recording ? "secondary" : "outline"}
                    size="sm"
                    disabled={filePending || pending}
                    aria-pressed={recording}
                    onClick={toggleRecording}
                  >
                    {recording ? <Square aria-hidden /> : <Mic aria-hidden />}
                    {recording ? "Stop and save" : "Voice note"}
                  </Button>
                  <span className="text-data text-muted-foreground">
                    Up to {MAX_UPLOAD_LABEL}. Files are stored as-is; a voice note is kept and transcribed once
                    transcription is set up.
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="capture-why" className="text-body-dense font-medium">
                    Why does this matter? <span className="font-normal text-muted-foreground">Optional</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="capture-why"
                      ref={whyInput}
                      value={why?.kind === "answer" ? why.text : ""}
                      disabled={why?.kind === "unknown"}
                      maxLength={WHY_MAX}
                      onChange={(event) =>
                        setWhy(
                          event.target.value.trim() ? { kind: "answer", text: event.target.value, via: "text" } : null,
                        )
                      }
                      placeholder={why?.kind === "unknown" ? "Not yet - that's fine" : "Say it in a line, or skip"}
                    />
                    <DictationButton
                      size="icon-sm"
                      variant="outline"
                      field={() => whyInput.current}
                      disabled={why?.kind === "unknown"}
                      onDictated={() =>
                        setWhy((current) => (current?.kind === "answer" ? { ...current, via: "voice" } : current))
                      }
                    />
                    <Button
                      type="button"
                      variant={why?.kind === "unknown" ? "secondary" : "outline"}
                      size="sm"
                      aria-pressed={why?.kind === "unknown"}
                      onClick={() => setWhy((current) => (current?.kind === "unknown" ? null : { kind: "unknown" }))}
                    >
                      I don&apos;t know yet
                    </Button>
                  </div>
                  <CaptureProvenance snapshot={snapshot} />
                </div>
              </form>
              <ImportDrop
                hint="Add pasted text or a URL. Files upload through Polymath Knowledge, where they are extracted."
                onImport={(result) => {
                  if (result.kind === "file") {
                    setSaveError("Use Attach file to keep it as-is in the inbox, or Polymath Knowledge to extract it.");
                    setSaveErrorId(null);
                    return;
                  }
                  setText((current) => (current ? `${current}\n${result.value}` : result.value));
                }}
              />
              {saveError ? (
                <p className="text-destructive text-body-dense" role="alert">
                  {saveError}
                  {saveErrorId ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground"
                        onClick={() => navigate(`/command-center/inbox?id=${saveErrorId}`)}
                      >
                        Open the one you already have
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button type="submit" form="quick-capture-form" disabled={!text.trim() || pending}>
                  Save capture
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/*
 * What is stored besides the words, said back in one quiet line so nothing is
 * a surprise and nothing needs a decision.
 */
function CaptureProvenance({ snapshot }: { snapshot: CaptureSnapshot | null }) {
  const context = snapshot?.context;
  if (!context) return null;
  const parts = [
    context.turn ? "the conversation turn" : context.source?.title ? `from ${context.source.title}` : null,
    context.passage ? "your selection and the text around it" : null,
    context.suggestion?.projectId ? "a suggestion to file it under this project" : null,
  ].filter(Boolean);
  return (
    <p className="text-data text-muted-foreground">
      Kept with it: the time{parts.length ? `, ${parts.join(", ")}` : ""}.
      {context.partial ? ` Partial: ${context.partial.reason}` : ""}
    </p>
  );
}

const WHY_MAX = 4_000;
