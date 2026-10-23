"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Inbox, Keyboard, ListTodo, Paperclip, Plus, Search, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { additionalDestinationsIn, destinations, type AppSlug } from "@/lib/navigation";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ImportDrop } from "@/components/workspace/import-drop";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { quickCreate, refreshInbox, searchWorkspace, type WorkspaceRecord } from "./shell-actions";

const subscribeToHydration = () => () => {};

export function CommandLayer() {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const { notify } = useWorkspace();
  const router = useRouter();
  const [mode, setMode] = useState<"search" | "capture" | null>(null);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"capture" | "task" | "note">("capture");
  const [saveError, setSaveError] = useState("");
  const [saveErrorId, setSaveErrorId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState(0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const captureTrigger = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filePending, setFilePending] = useState(false);
  const returnTo = useRef<"search" | "capture">("search");

  function open(next: "search" | "capture") {
    returnTo.current = next;
    setQuery("");
    setSelected(0);
    setMode(next);
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        returnTo.current = "search";
        setQuery(""); setSelected(0);
        setMode((current) => current === "search" ? null : "search");
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault(); returnTo.current = "capture"; setMode("capture");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const navigation = [...destinations, ...["command-center", "neuralflow", "alfred"].flatMap((slug) => additionalDestinationsIn(slug as AppSlug))].map((destination) => ({
    key: destination.href, label: destination.label,
    context: destination.href.startsWith("/apps/") ? "Preview tool" : destination.group === "shared" ? "Shared workspace" : "Polymath",
    icon: destination.icon, href: destination.href,
  }));
  // Canonical record search: debounced server query over saved tasks, notes,
  // people, and inbox items - the rows every other surface reads.
  const search = query.trim();
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search.length < 2) { setRecords([]); setSearched(false); return; }
      void searchWorkspace(search)
        .then((found) => { setRecords(found); setSearched(true); })
        .catch(() => { setRecords([]); setSearched(true); });
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const recordResults = records.map((record) => ({
    key: record.id, label: record.label, context: record.context,
    icon: record.kind === "task" ? ListTodo : record.kind === "contact" ? Users : record.kind === "inbox" ? Inbox : FileText,
    href: record.href,
  }));
  const navMatches = search ? navigation.filter((result) => `${result.label} ${result.context}`.toLowerCase().includes(search.toLowerCase())) : navigation;
  const matches = search ? [...recordResults, ...navMatches] : navigation;
  const results = matches.slice(0, 20);
  const active = Math.min(selected, Math.max(0, results.length - 1));

  function navigate(href: string) { setMode(null); router.push(href); }
  // Files and screenshots capture through the multipart API route (server
  // actions cap below the 4.5 MB function ceiling), then the cached inbox is
  // refreshed so the new row is there when the dialog lands on it.
  function attachFile(file: File) {
    if (filePending || pending) return;
    setSaveError("");
    setSaveErrorId(null);
    // Matches the API route's deploy-supported cap; the message shows BEFORE submit.
    if (file.size > 4 * 1024 * 1024) { setSaveError("Captures are limited to 4 MB - the largest upload this app accepts."); return; }
    setFilePending(true);
    const form = new FormData();
    form.set("file", file);
    void fetch("/api/v1/captures/file", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: form })
      .then(async (res) => {
        if (!res.ok) {
          // A platform-level 413 answers with an HTML error page, not a
          // problem body - name the limit either way, and never auto-retry.
          if (res.status === 413) { setSaveError("That file is over the 4 MB limit."); return; }
          const problem = (await res.json().catch(() => null)) as { title?: string } | null;
          setSaveError(problem?.title ?? "Could not capture the file. Try again.");
          return;
        }
        const created = (await res.json()) as { captureId: string; quarantined: boolean };
        await refreshInbox();
        notify(created.quarantined ? `Captured ${file.name} - type not recognized, stored as-is.` : `Captured ${file.name}.`);
        setText(""); setMode(null);
        navigate(`/command-center/inbox?id=${created.captureId}`);
      })
      .catch(() => setSaveError("Could not capture the file. Try again."))
      .finally(() => setFilePending(false));
  }
  function saveCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || pending) return;
    setSaveError("");
    setSaveErrorId(null);
    setPending(true);
    void quickCreate(kind, text, crypto.randomUUID())
      .then((result) => {
        if (!result.ok) { setSaveError(result.error); setSaveErrorId(result.existingId ?? null); return; }
        notify(result.message);
        setText(""); setMode(null);
      })
      .catch(() => setSaveError("Could not save. Try again."))
      .finally(() => setPending(false));
  }

  return <>
    <span className="contents md:hidden"><button ref={searchTrigger} type="button" disabled={!hydrated} onClick={() => open("search")} aria-label="Search workspace" aria-keyshortcuts="Meta+K Control+K" data-search-trigger className="global-search disabled:opacity-50">
      <Search aria-hidden className="size-4 shrink-0" /><span className="hidden lg:inline">Search your workspace</span><kbd aria-hidden className="readout ml-auto hidden text-[11px] lg:block">⌘ K</kbd>
    </button></span>
    <Button ref={captureTrigger} size="sm" disabled={!hydrated} onClick={() => open("capture")} aria-keyshortcuts="Meta+Shift+C Control+Shift+C"><Plus aria-hidden /><span className="hidden sm:inline">Capture</span><span className="sr-only sm:hidden">Capture</span></Button>
    <Dialog open={mode !== null} onOpenChange={(value) => { if (!value) setMode(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onCloseAutoFocus={(event) => { event.preventDefault(); if (returnTo.current === "capture") { captureTrigger.current?.focus(); return; } const triggers = Array.from(document.querySelectorAll<HTMLElement>("[data-search-trigger]")); (triggers.find((el) => el.offsetParent !== null) ?? searchTrigger.current)?.focus(); }}>
        <DialogTitle>{mode === "search" ? "Search and commands" : "Capture without switching context"}</DialogTitle>
        <DialogDescription>{mode === "search" ? "Navigate anywhere, or find saved tasks, notes, people and inbox items. Documents use the search in Alfred Knowledge." : "Saved to your workspace: the durable inbox, the canonical task list, or your notebook."}</DialogDescription>
        {mode === "search" ? <>
          <Input key="search" autoFocus className="h-11 border-transparent bg-muted/60 text-[14px] focus-visible:ring-1" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search workspace" value={query} placeholder="Search tasks, notes, people and destinations" onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setSelected(Math.min(active + 1, results.length - 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setSelected(Math.max(active - 1, 0)); }
            if (event.key === "Enter" && results[active]) { event.preventDefault(); navigate(results[active].href); }
          }} aria-controls="command-results" aria-activedescendant={results[active] ? `command-${active}` : undefined} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 justify-start" onClick={() => setMode("capture")}><Plus aria-hidden />Capture something<span className="readout ml-auto text-[11px]">Ctrl/⌘ Shift C</span></Button>
            {/* The header stays quiet: the shortcuts list lives here, on the
                keyboard surface, instead of a sixth header control. Shift+?
                still opens it from anywhere. */}
            <ShortcutsDialog trigger={<Button variant="outline" aria-label="Keyboard shortcuts"><Keyboard aria-hidden /><span className="hidden sm:inline">Shortcuts</span><span className="readout ml-auto hidden text-[11px] sm:inline">Shift ?</span></Button>} />
          </div>
          <div id="command-results" role="listbox" aria-label="Search results" className="max-h-[45dvh] overflow-y-auto">
            {results.map((result, index) => <button key={result.key} id={`command-${index}`} role="option" aria-selected={active === index} type="button" onClick={() => navigate(result.href)} onMouseEnter={() => setSelected(index)} className="command-result">
              <result.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="flex min-w-0 flex-1 flex-col items-start"><span className="max-w-full truncate">{result.label}</span><span className="text-[11px] text-muted-foreground">{result.context}</span></span><ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </button>)}
          </div>
          <p role="status" className="text-xs text-muted-foreground">{matches.length === 0 ? (search && !searched ? "Searching…" : "No results. Capture a new item or try a different search.") : matches.length > results.length ? `Showing ${results.length} of ${matches.length} matches. Refine your search for more.` : `${matches.length} ${matches.length === 1 ? "result" : "results"}`}</p>
        </> : <>
          <form id="quick-capture-form" onSubmit={saveCapture} className="flex flex-col gap-4">
            <div className="flex gap-2" aria-label="Capture destination">
              {([{ value: "capture", label: "Inbox", icon: Inbox }, { value: "task", label: "Task", icon: ListTodo }, { value: "note", label: "Note", icon: FileText }] as const).map((item) => <Button key={item.value} type="button" variant={kind === item.value ? "secondary" : "ghost"} aria-pressed={kind === item.value} onClick={() => setKind(item.value)}><item.icon aria-hidden />{item.label}</Button>)}
            </div>
            <label className="flex flex-col gap-2 text-[13px] font-medium">Capture content<Textarea key="capture" autoFocus required rows={4} maxLength={10000} value={text} onChange={(event) => setText(event.target.value)} placeholder="A thought, a task, a link, or something to clarify" /></label>
            {kind === "capture" ? (
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" className="hidden" aria-hidden tabIndex={-1} onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) attachFile(chosen); }} />
                <Button type="button" variant="outline" size="sm" disabled={filePending || pending} onClick={() => fileInput.current?.click()}><Paperclip aria-hidden />{filePending ? "Capturing…" : "Attach file"}</Button>
                <span className="text-[11px] text-muted-foreground">File or screenshot, up to 4 MB. Stored as-is; contents aren&apos;t searchable.</span>
              </div>
            ) : null}
          </form>
          <ImportDrop hint="Add pasted text or a URL. Files upload through Alfred Knowledge, where they are extracted." onImport={(result) => {
            if (result.kind === "file") { setSaveError("Use Attach file to keep it as-is in the inbox, or Alfred Knowledge to extract it."); setSaveErrorId(null); return; }
            setText((current) => current ? `${current}\n${result.value}` : result.value);
          }} />
          {saveError ? (
            <p className="text-destructive text-[13px]" role="alert">
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
          <div className="flex justify-end"><Button type="submit" form="quick-capture-form" disabled={!text.trim() || pending}>Save capture</Button></div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
