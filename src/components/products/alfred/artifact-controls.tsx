"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Plus, Save, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, Field, Status, SearchField } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact, ArtifactKind } from "@/components/workspace/types";

export function artifactHref(record: Pick<Artifact, "id" | "kind" | "tags">) {
  const slug = record.tags.includes("Blog draft") ? "blogs" : ({ source: "library", document: "library", note: "notebook", zettel: "zettels", dossier: "dossiers", canvas: "canvas" })[record.kind];
  return `/apps/alfred/${slug}?id=${encodeURIComponent(record.id)}`;
}
export function taskHref(id: string) { return `/apps/neuralflow/tasks?task=${encodeURIComponent(id)}`; }
export function ArtifactLink({ record }: { record: Artifact }) { return <Link className="inline-flex min-h-6 items-center gap-1.5 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring" href={artifactHref(record)}><Link2 aria-hidden className="size-3" />{record.title}</Link>; }
export function NewArtifact({ kind, label, onCreated, defaultBody = "", tags = [] }: { kind: ArtifactKind; label: string; onCreated?: (record: Artifact) => void; defaultBody?: string; tags?: string[] }) {
  const { addArtifact, updateArtifact } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(defaultBody);
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus aria-hidden />{label}</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogTitle>{label}</DialogTitle><DialogDescription>Create a canonical {kind} in the browser-only preview. It can link to many workspace records.</DialogDescription><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); const record = addArtifact(title, kind, body); if (record) { if (tags.length) updateArtifact(record.id, { tags }); onCreated?.({ ...record, tags }); setTitle(""); setBody(defaultBody); setOpen(false); } }}><Field label="Title"><Input required maxLength={240} value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Field label={kind === "zettel" ? "One idea, in your own words" : "Content"}><Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></Field><Button type="submit" disabled={!title.trim()}>Create {kind}</Button></form></DialogContent></Dialog>;
}
export function ArtifactList({ records, selectedId, onSelect, empty = "No records yet" }: { records: Artifact[]; selectedId?: string; onSelect: (id: string) => void; empty?: string }) {
  const [query, setQuery] = useState("");
  const matches = records.filter((record) => `${record.title} ${record.tags.join(" ")} ${record.body}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-3"><SearchField value={query} onChange={setQuery} placeholder="Search titles, text and tags" /><div className="max-h-[34rem] overflow-y-auto">{matches.length ? matches.slice(0, 200).map((record) => <button key={record.id} type="button" aria-pressed={selectedId === record.id} onClick={() => onSelect(record.id)} className="flex w-full flex-col gap-1 border-b border-border px-2 py-3 text-left text-[13px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted"><span className="font-medium">{record.title}</span><span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{record.kind}</span><span className="readout">v{record.version}</span>{record.tags.slice(0, 2).map((tag) => <Status key={tag}>{tag}</Status>)}</span></button>) : <Empty title={empty} description={query ? "Try a shorter query or clear the search." : "Create an item to start connecting your knowledge."} />}</div>{matches.length > 200 && <p className="text-xs text-muted-foreground">Showing the first 200 matches. Narrow your search.</p>}</div>;
}
export function RecordLinks({ record }: { record: Artifact }) {
  const { state, updateArtifact } = useWorkspace();
  const [query, setQuery] = useState("");
  const all = [
    ...state.artifacts.filter((item) => item.id !== record.id).map((item) => ({ id: item.id, title: item.title, kind: item.kind, href: artifactHref(item) })),
    ...state.tasks.map((item) => ({ id: item.id, title: item.title, kind: "task", href: taskHref(item.id) })),
    ...state.projects.map((item) => ({ id: item.id, title: item.title, kind: "project", href: `/apps/alfred/projects?id=${item.id}` })),
    ...state.contacts.map((item) => ({ id: item.id, title: item.name, kind: "contact", href: `/apps/command-center/contacts?id=${item.id}` })),
    ...state.companies.map((item) => ({ id: item.id, title: item.name, kind: "company", href: `/apps/command-center/companies?id=${item.id}` })),
    ...state.opportunities.map((item) => ({ id: item.id, title: item.title, kind: "opportunity", href: `/apps/command-center/opportunities?id=${item.id}` })),
  ];
  const backlinks = state.artifacts.filter((item) => item.links.includes(record.id));
  return <div className="space-y-4 text-[13px]"><div><h3 className="mb-2 font-medium">Linked records</h3>{record.links.length ? record.links.map((id) => { const item = all.find((item) => item.id === id); return <div key={id} className="flex items-center justify-between gap-2 py-1"><Link className="min-h-6 text-primary hover:underline" href={item?.href || "#"}>{item?.title || `Unavailable record (${id})`}</Link><Button size="xs" variant="ghost" aria-label={`Unlink ${item?.title || id}`} onClick={() => updateArtifact(record.id, { links: record.links.filter((link) => link !== id) })}>Unlink</Button></div>; }) : <p className="text-muted-foreground">No linked records.</p>}</div><Dialog><DialogTrigger asChild><Button variant="outline"><Link2 aria-hidden />Link records</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogTitle>Link workspace records</DialogTitle><DialogDescription>Links refer to existing identities, not copies. Select as many records as this idea needs.</DialogDescription><SearchField value={query} onChange={setQuery} placeholder="Find a record to link" /><div className="max-h-80 space-y-1 overflow-auto">{all.filter((item) => `${item.title} ${item.kind}`.toLowerCase().includes(query.toLowerCase())).map((item) => <label key={item.id} className="flex min-h-9 items-center gap-3 rounded-md p-2 text-[13px] hover:bg-muted"><input type="checkbox" checked={record.links.includes(item.id)} onChange={(e) => updateArtifact(record.id, { links: e.target.checked ? [...record.links, item.id] : record.links.filter((id) => id !== item.id) })} /><span className="flex-1">{item.title}</span><span className="text-xs text-muted-foreground">{item.kind}</span></label>)}</div></DialogContent></Dialog><div><h3 className="mb-2 font-medium">Backlinks</h3>{backlinks.length ? backlinks.map((item) => <div key={item.id} className="py-1"><ArtifactLink record={item} /></div>) : <p className="text-muted-foreground">No incoming artifact links.</p>}</div></div>;
}
export function ArtifactEditor({ record, children }: { record: Artifact; children?: ReactNode }) {
  const { updateArtifact, notify } = useWorkspace();
  const [title, setTitle] = useState(record.title);
  const [body, setBody] = useState(record.body);
  const [tags, setTags] = useState(record.tags.join(", "));
  return <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!updateArtifact(record.id, { title: title.trim(), body, tags: [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))] }).ok) return; notify("Artifact saved in this browser preview."); }}><div className="flex flex-wrap items-center justify-between gap-2"><Status>{record.kind}</Status><span className="readout text-xs text-muted-foreground">v{record.version}</span></div><Field label="Title"><Input required value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Field label={record.kind === "zettel" ? "Atomic idea" : "Content"}><Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} /></Field><Field label="Tags, separated by commas"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field><Button type="submit" disabled={!title.trim()}><Save aria-hidden />Save changes</Button>{children}</form>;
}
