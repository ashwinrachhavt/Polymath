"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { FileText, Inbox, Plus, Search, ListTodo, ArrowRight, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { products, productHref } from "@/lib/products";
import { useWorkspace } from "@/components/workspace/workspace-provider";

const subscribeToHydration = () => () => {};
export function CommandLayer() {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const { state, addCapture, addTask, addArtifact, notify } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState(false);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState("capture");
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((v) => !v); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); setOpen(false); setCapture(true); }
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, []);
  const search = query.trim().toLowerCase();
  const destinations = products.flatMap((p) => p.destinations.map((d) => ({ key: productHref(p, d.slug), label: d.label, context: p.name, icon: d.icon, href: productHref(p, d.slug) })));
  const records = [
    ...state.contacts.map((c) => ({ key: c.id, label: c.name, context: `Contact at ${c.company}`, icon: Users, href: "/apps/command-center/contacts" })),
    ...state.tasks.map((t) => ({ key: t.id, label: t.title, context: "Task in NeuralFlow", icon: ListTodo, href: "/apps/neuralflow/tasks" })),
    ...state.artifacts.map((a) => ({ key: a.id, label: a.title, context: `${a.kind} in Alfred`, icon: FileText, href: a.kind === "note" ? "/apps/alfred/notebook" : a.kind === "dossier" ? "/apps/alfred/dossiers" : a.kind === "zettel" ? "/apps/alfred/zettels" : "/apps/alfred/library" })),
  ];
  const results = (search ? [...destinations, ...records].filter((r) => `${r.label} ${r.context}`.toLowerCase().includes(search)) : destinations.filter((r) => ["Briefing", "Tasks", "Notebook", "Reviews", "Calendar", "Ask Alfred"].includes(r.label))).slice(0, 20);
  function navigate(href: string) { setOpen(false); router.push(href); }
  function saveCapture(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!text.trim()) return;
    if (kind === "task") addTask(text);
    else if (kind === "note") addArtifact(text.split("\n")[0].slice(0, 120), "note", text);
    else addCapture(text, /^https?:\/\//i.test(text.trim()) ? "url" : "text");
    notify(`${kind === "task" ? "Task" : kind === "note" ? "Note" : "Item"} captured in the browser preview`);
    setText(""); setCapture(false);
  }
  return <><button type="button" disabled={!hydrated} onClick={() => setOpen(true)} className="global-search"><Search aria-hidden className="size-4"/><span className="hidden lg:inline">Search your workspace</span><kbd className="readout ml-auto hidden text-[10px] sm:block">⌘ K</kbd></button><Button size="sm" disabled={!hydrated} onClick={() => setCapture(true)}><Plus aria-hidden/><span className="hidden sm:inline">Capture</span><span className="sr-only sm:hidden">Capture</span></Button>
  <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-xl"><DialogTitle>Search and commands</DialogTitle><DialogDescription>Find a destination or a canonical record. Record results open their collection.</DialogDescription><Input autoFocus aria-label="Search workspace" value={query} placeholder="Search tasks, notes, people and destinations…" onChange={(e) => { setQuery(e.target.value); setSelected(0); }} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); } if (e.key === "Enter" && results[selected]) { e.preventDefault(); navigate(results[selected].href); } }} aria-controls="command-results" aria-activedescendant={results[selected] ? `command-${selected}` : undefined}/><div id="command-results" className="max-h-[50vh] overflow-y-auto"><button type="button" onClick={() => { setOpen(false); setCapture(true); }} className="command-result"><Plus aria-hidden className="size-4"/><span>Capture something</span><kbd className="ml-auto text-[10px]">Ctrl/⌘ Shift C</kbd></button>{results.map((r,i) => <button key={r.key} id={`command-${i}`} type="button" onClick={() => navigate(r.href)} onMouseEnter={() => setSelected(i)} className={`command-result ${selected === i ? "bg-muted" : ""}`}><r.icon aria-hidden className="size-4 text-muted-foreground"/><span className="flex min-w-0 flex-1 flex-col items-start"><span className="truncate">{r.label}</span><span className="text-[11px] text-muted-foreground">{r.context}</span></span><ArrowRight aria-hidden className="size-3 text-muted-foreground"/></button>)}{results.length === 0 && <p className="p-5 text-[13px] text-muted-foreground">No results. Capture a new task or try a different search.</p>}</div></DialogContent></Dialog>
  <Dialog open={capture} onOpenChange={setCapture}><DialogContent className="sm:max-w-lg"><DialogTitle>Capture without switching context</DialogTitle><DialogDescription>Save to the shared inbox, task list or notebook. Browser preview only.</DialogDescription><form onSubmit={saveCapture} className="flex flex-col gap-4"><div className="flex gap-2">{[{value:"capture",label:"Inbox",icon:Inbox},{value:"task",label:"Task",icon:ListTodo},{value:"note",label:"Note",icon:FileText}].map((k) => <Button key={k.value} type="button" variant={kind === k.value ? "secondary" : "ghost"} aria-pressed={kind === k.value} onClick={() => setKind(k.value)}><k.icon aria-hidden/>{k.label}</Button>)}</div><Textarea autoFocus required aria-label="Capture content" rows={5} maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} placeholder="A thought, a task, a link, or something to clarify…"/><div className="flex justify-end"><Button type="submit" disabled={!text.trim()}>Save capture</Button></div></form></DialogContent></Dialog></>;
}
