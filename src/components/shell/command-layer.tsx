"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Inbox, ListTodo, Plus, Search, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { additionalDestinationsIn, apps, destinations } from "@/lib/navigation";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ImportDrop } from "@/components/workspace/import-drop";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { quickCreate, searchWorkspace, type WorkspaceRecord } from "./shell-actions";

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
  const [pending, setPending] = useState(false);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState(0);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const captureTrigger = useRef<HTMLButtonElement>(null);
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

  const navigation = [...destinations, ...apps.flatMap((app) => additionalDestinationsIn(app.slug))].map((destination) => ({
    key: destination.href, label: destination.label,
    context: destination.href.startsWith("/apps/") ? `${apps.find((app) => app.slug === destination.group)?.label} preview tool` : destination.group === "shared" ? "Shared workspace" : apps.find((app) => app.slug === destination.group)?.label ?? "Axiom",
    icon: destination.icon, href: destination.href,
  }));
  // Canonical record search: debounced server query over saved tasks, notes,
  // people, and inbox items - the rows every other surface reads.
  const search = query.trim();
  useEffect(() => {
    if (search.length < 2) { setRecords([]); setSearched(false); return; }
    setSearched(false);
    const timer = setTimeout(() => {
      void searchWorkspace(search).then((found) => { setRecords(found); setSearched(true); }).catch(() => { setRecords([]); setSearched(true); });
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
  function saveCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || pending) return;
    setSaveError("");
    setPending(true);
    void quickCreate(kind, text, crypto.randomUUID())
      .then((result) => {
        if (!result.ok) { setSaveError(result.error); return; }
        notify(result.message);
        setText(""); setMode(null);
      })
      .catch(() => setSaveError("Could not save. Try again."))
      .finally(() => setPending(false));
  }

  return <>
    <span className="contents md:hidden"><button ref={searchTrigger} type="button" disabled={!hydrated} onClick={() => open("search")} aria-label="Search workspace" aria-keyshortcuts="Meta+K Control+K" data-search-trigger className="global-search disabled:opacity-50">
      <Search aria-hidden className="size-4 shrink-0" /><span className="hidden lg:inline">Search your workspace</span><kbd className="readout ml-auto hidden text-[10px] lg:block">⌘ K</kbd>
    </button></span>
    <Button ref={captureTrigger} size="sm" disabled={!hydrated} onClick={() => open("capture")} aria-keyshortcuts="Meta+Shift+C Control+Shift+C"><Plus aria-hidden /><span className="hidden sm:inline">Capture</span><span className="sr-only sm:hidden">Capture</span></Button>
    <span className="hidden md:inline-flex"><ShortcutsDialog /></span>
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
          <Button variant="outline" className="justify-start" onClick={() => setMode("capture")}><Plus aria-hidden />Capture something<span className="readout ml-auto text-[10px]">Ctrl/⌘ Shift C</span></Button>
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
          </form>
          <ImportDrop hint="Add pasted text or a URL. Files upload through Alfred Knowledge, where they are extracted." onImport={(result) => {
            if (result.kind === "file") { setSaveError("Quick capture handles text and URLs. Add files in Alfred Knowledge."); return; }
            setText((current) => current ? `${current}\n${result.value}` : result.value);
          }} />
          {saveError ? <p className="text-destructive text-[13px]" role="alert">{saveError}</p> : null}
          <div className="flex justify-end"><Button type="submit" form="quick-capture-form" disabled={!text.trim() || pending}>Save capture</Button></div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
