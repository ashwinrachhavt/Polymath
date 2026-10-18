"use client";

import { useEffect, useState } from "react";
import { Save, History, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Screen, Panel, Field, Empty, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact } from "@/components/workspace/types";
import { ArtifactList, NewArtifact, RecordLinks } from "./artifact-controls";
import { clearDraft, readDraft, writeDraft } from "./working-draft";
import RichEditor from "./rich-editor";

function RichNote({ record }: { record: Artifact }) {
  const { state, storageScope, updateArtifact, notify } = useWorkspace();
  const [title, setTitle] = useState(record.title);
  const [body, setBody] = useState(record.body);
  const [tags, setTags] = useState(record.tags.join(", "));
  // A draft left by an interrupted session is offered, never applied silently:
  // restoring text the owner did not ask for is its own kind of data loss.
  const [draft, setDraft] = useState(() => readDraft(storageScope, record.id));
  const dirty = title !== record.title || body !== record.body || tags !== record.tags.join(", ");
  const versions = state.artifactVersions.filter((item) => item.artifactId === record.id).sort((a, b) => b.version - a.version);
  useEffect(() => {
    if (!dirty) return;
    // The draft is written on edit rather than on a timer: a debounce that has
    // not fired yet is exactly the draft a refresh loses.
    writeDraft(storageScope, record.id, { title, body, tags });
  }, [storageScope, record.id, dirty, title, body, tags]);
  function save() {
    if (!title.trim()) return;
    const idLinks = [...body.matchAll(/\/apps\/alfred\/[a-z-]+\?id=([a-zA-Z0-9-]+)/g)].map((match) => match[1]).filter((id) => id !== record.id && state.artifacts.some((item) => item.id === id));
    // [[Title]] resolves against this workspace. A title matching nothing is
    // left in the text as the owner wrote it and simply creates no backlink.
    const titleLinks = [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((match) => state.artifacts.find((item) => item.title.toLowerCase() === match[1].trim().toLowerCase())?.id).filter((id): id is string => Boolean(id) && id !== record.id);
    const embeddedLinks = [...new Set([...idLinks, ...titleLinks])];
    const result = updateArtifact(record.id, { title: title.trim(), body, tags: [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))], links: [...new Set([...record.links, ...embeddedLinks])] });
    // The notice is the only place the owner learns whether this survived a
    // refresh, so it is driven by what the store actually did.
    if (!result.ok) { notify("Another tab changed this notebook. This note was not saved; copy your text, reload, and paste it into the latest version."); return; }
    if (!result.persisted) { notify("Saved in this tab only. Browser storage refused the write, so refreshing will lose this note — export it now."); return; }
    clearDraft(storageScope, record.id);
    setDraft(undefined);
    notify("Note saved with a canonical browser-only checkpoint.");
  }
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><Status>{dirty ? "Unsaved working draft" : "Saved canonical note"}</Status><span className="readout text-xs text-muted-foreground">v{record.version}</span></div>{draft && <div role="status" className="panel flex flex-wrap items-center gap-3 p-3 text-[13px]"><span className="min-w-0 flex-1">An unsaved draft from {draft.at ? new Date(draft.at).toLocaleString() : "an earlier session"} is kept in this browser for this note.</span><Button type="button" size="sm" onClick={() => { setTitle(draft.title); setBody(draft.body); setTags(draft.tags); setDraft(undefined); }}>Restore draft</Button><Button type="button" size="sm" variant="ghost" onClick={() => { clearDraft(storageScope, record.id); setDraft(undefined); }}>Discard</Button></div>}<Field label="Note title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field><RichEditor content={body} onChange={setBody} /><Field label="Tags, separated by commas"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field><div className="flex flex-wrap gap-2"><Button onClick={save} disabled={!title.trim()}><Save aria-hidden />Save checkpoint</Button><Dialog><DialogTrigger asChild><Button variant="outline"><History aria-hidden />History ({versions.length})</Button></DialogTrigger><DialogContent className="sm:max-w-xl"><DialogTitle>Canonical checkpoint history</DialogTitle><DialogDescription>Browser-only artifact versions shared across all three products. Restoring fills the working editor; save it as a new version rather than overwriting history.</DialogDescription><div className="max-h-80 space-y-3 overflow-auto">{versions.length ? versions.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-border py-2"><div><p className="text-[13px]">{item.title}</p><p className="readout text-xs text-muted-foreground">v{item.version} / {new Date(item.createdAt).toLocaleString()}</p></div><Button size="sm" variant="outline" onClick={() => { setBody(item.body); setTitle(item.title); setTags(item.tags.join(", ")); notify("Checkpoint restored into the working editor. Save it to create a new revision."); }}>Restore</Button></div>) : <Empty title="No checkpoints" description="Save a checkpoint before exploring a different direction." />}</div></DialogContent></Dialog><Button variant="ghost" onClick={() => { const blob = new Blob([`# ${title}\n\n${body}`], { type: "text/markdown" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${title || "note"}.md`; anchor.click(); URL.revokeObjectURL(url); }}><Download aria-hidden />Export Markdown</Button></div><p className="text-xs text-muted-foreground">Save before switching notes. Unsaved changes are kept as a draft in this browser only, offered back when you return to this note; browsers that block storage will say so instead. Checkpoints are local, not production immutable versions.</p></div>;
}
export default function Notebook({ initialId }: { initialId?: string }) {
  const { state } = useWorkspace();
  const [id, setId] = useState(initialId || "note-axiom");
  const notes = state.artifacts.filter((item) => item.kind === "note");
  const record = notes.find((item) => item.id === id);
  return <Screen title="Notebook" description="Rich canonical notes, local checkpoints and explicit backlinks. The same note identities appear in NeuralFlow and Command Center." actions={<NewArtifact kind="note" label="New note" onCreated={(record) => setId(record.id)} />}><div className="grid gap-6 xl:grid-cols-[250px_minmax(0,1fr)_280px]"><Panel title="Notes"><ArtifactList records={notes} selectedId={id} onSelect={setId} /></Panel>{record ? <><Panel title="Working note"><RichNote key={record.id} record={record} /></Panel><Panel title="Linked context"><RecordLinks record={record} /></Panel></> : <Empty title="Choose a note" description="Select a canonical note or start writing a new one." />}</div></Screen>;
}
