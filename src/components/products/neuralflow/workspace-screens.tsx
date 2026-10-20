"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
const RichEditor = dynamic(() => import("@/components/products/alfred/rich-editor"), { ssr: false, loading: () => <p role="status" className="text-xs text-muted-foreground">Loading rich editor…</p> });
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select } from "@/components/ui/select";
import { Empty, Field, Panel, Screen, SearchField, Stat, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact, Project } from "@/components/workspace/types";
import { NewTask, TaskRow } from "./task-components";

export function NewNote({ link, label = "New note" }: { link?: string; label?: string }) {
  const { addArtifact, updateArtifact, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const note = addArtifact(String(data.get("title") || ""), "note", String(data.get("body") || ""));
    if (!note) return;
    if (link) updateArtifact(note.id, { links: [link] });
    setOpen(false); notify("Canonical note created in this browser preview. It is also visible in the library.");
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button>{label}</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Create a canonical note</DialogTitle><DialogDescription>This is the same note collection used across the workspace, not a separate copy.</DialogDescription></DialogHeader><form onSubmit={create} className="space-y-4"><Field label="Title"><Input name="title" required maxLength={300} autoFocus /></Field><Field label="Note body"><Textarea name="body" rows={8} /></Field><Button type="submit">Create note locally</Button></form></DialogContent></Dialog>;
}

function NoteEditor({ note, close }: { note: Artifact; close: () => void }) {
  const { state, updateArtifact, notify } = useWorkspace();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(", "));
  const [links, setLinks] = useState(note.links);
  const [error, setError] = useState("");
  const [baselineVersion] = useState(note.version);
  const [editorMode, setEditorMode] = useState("rich");
  const versions = state.artifactVersions.filter((version) => version.artifactId === note.id).sort((a, b) => b.version - a.version);
  const targets = [...state.tasks.map((task) => ({ id: task.id, title: task.title, kind: "Task" })), ...state.projects.map((project) => ({ id: project.id, title: project.title, kind: "Project" })), ...state.events.map((event) => ({ id: event.id, title: `${event.title} (${event.date})`, kind: "Event" })), ...state.artifacts.filter((artifact) => artifact.id !== note.id).map((artifact) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind }))];
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) { setError("Enter a note title."); return; }
    if (state.artifacts.find((artifact) => artifact.id === note.id)?.version !== baselineVersion) { setError("This note changed in another view. Your draft has not been overwritten. Copy it, then close and reopen the note to load the latest revision."); return; }
    updateArtifact(note.id, { title: title.trim(), body, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), links });
    notify("Canonical note saved locally. No AI rewrite was performed."); close();
  }
  return <form className="space-y-4" onSubmit={save}><Field label="Note title"><Input value={title} required onChange={(event) => setTitle(event.target.value)} /></Field>
    <div><div className="mb-3 flex items-center justify-between gap-3"><p className="text-[13px] font-medium">Canonical note body</p><Button type="button" variant="outline" size="sm" onClick={() => setEditorMode(editorMode === "rich" ? "markdown" : "rich")}>{editorMode === "rich" ? "Edit Markdown" : "Rich editor"}</Button></div>{editorMode === "rich" ? <RichEditor content={body} onChange={setBody} /> : <Textarea aria-label="Canonical note body" rows={15} value={body} onChange={(event) => setBody(event.target.value)} />}<p className="mt-2 text-xs text-muted-foreground">Markdown body shared across the workspace. Save explicitly; there is no silent autosave or AI insertion.</p></div>
    <Field label="Tags (comma-separated)"><Input value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
    <fieldset><legend className="mb-2 text-[13px] font-medium">Link workspace records</legend><div className="max-h-52 space-y-2 overflow-y-auto rounded-lg border border-border p-3">{targets.map((target) => <label key={target.id} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 size-4" checked={links.includes(target.id)} onChange={(event) => setLinks(event.target.checked ? [...links, target.id] : links.filter((id) => id !== target.id))} /><span>{target.kind}: {target.title}</span></label>)}</div>{links.filter((id) => !targets.some((target) => target.id === id)).length > 0 && <p className="mt-2 text-xs text-muted-foreground">Existing links to unavailable records are preserved.</p>}</fieldset>
    <Panel title="Backlinks">{state.artifacts.filter((artifact) => artifact.links.includes(note.id)).map((artifact) => <p key={artifact.id} className="py-1 text-xs">{artifact.title} ({artifact.kind})</p>)}{!state.artifacts.some((artifact) => artifact.links.includes(note.id)) && <p className="text-xs text-muted-foreground">No incoming artifact links.</p>}</Panel>
    {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" type="button" onClick={close}>Discard draft</Button><Button type="submit">Save note locally</Button></div><Panel title="Saved local revisions" description="Restore a snapshot into the current draft; Save creates a new revision rather than rewriting history."><div className="max-h-48 space-y-2 overflow-y-auto">{versions.map((version) => <div key={version.id} className="flex items-center justify-between gap-3 text-xs"><span className="readout">Revision {version.version}: {new Date(version.createdAt).toLocaleString()}</span><Button size="sm" variant="outline" type="button" onClick={() => { setTitle(version.title); setBody(version.body); setLinks(version.links); setTags(version.tags.join(", ")); }}>Load into draft</Button></div>)}{!versions.length && <p className="text-xs text-muted-foreground">No saved local snapshots for this note yet. Saving begins its revision history.</p>}</div></Panel><Unavailable feature="AI writing">Rewrite, summarize, continue, and action-item extraction require a supervised run. Rich formatting changes only text you wrote. Unsaved drafts are not recovered after refresh.</Unavailable>
  </form>;
}

export function NoteInspector({ note, initiallyOpen = false }: { note: Artifact; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><button className="w-full text-left text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-ring" type="button">{note.title}</button></SheetTrigger><SheetContent className="w-full overflow-y-auto p-4 sm:max-w-2xl"><SheetHeader className="px-0 pr-8"><SheetTitle>Canonical note</SheetTitle><SheetDescription>Revision {note.version}. {new Date(note.updatedAt).toLocaleDateString()}. Unsaved edits are a local draft until Save.</SheetDescription></SheetHeader>{open && <NoteEditor note={note} close={() => setOpen(false)} />}</SheetContent></Sheet>;
}

export function NotesScreen({ initialNote }: { initialNote?: string }) {
  const { state } = useWorkspace();
  const [search, setSearch] = useState(""); const [tag, setTag] = useState("all");
  const notes = state.artifacts.filter((artifact) => artifact.kind === "note");
  const tags = [...new Set(notes.flatMap((note) => note.tags))].filter((value) => !value.startsWith("neuralflow-focus:"));
  const visible = notes.filter((note) => `${note.title} ${note.body} ${note.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()) && (tag === "all" || note.tags.includes(tag))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = notes.find((note) => note.id === initialNote);
  return <Screen title="Notes" description="Capture what you learned and connect it to tasks, projects, events, or other artifacts. These are canonical workspace notes, shared across the workspace." actions={<NewNote />}>
    {initialNote && (selected ? <Panel title="Linked note"><NoteInspector key={selected.id} note={selected} initiallyOpen /></Panel> : <Empty title="Note not found" description="This note is not present in the current browser preview. It may belong to a different browser or a cleared preview workspace." />)}
    <Panel title="Canonical notebook" description={`${visible.length} matching notes`}><div className="mb-4 flex flex-wrap items-end gap-4"><SearchField value={search} onChange={setSearch} placeholder="Search note titles and bodies" /><Field label="Tag"><Select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">All tags</option>{tags.map((value) => <option key={value}>{value}</option>)}</Select></Field></div>{visible.length ? <ul className="divide-y divide-border">{visible.map((note) => <li key={note.id} className="py-4"><NoteInspector note={note} /><p className="mt-2 line-clamp-2 text-[13px] text-muted-foreground">{note.body || "Empty body; open to write."}</p><div className="mt-2 flex flex-wrap gap-2"><Status>Revision {note.version}</Status><span className="readout text-xs text-muted-foreground">{note.links.length} links</span>{note.tags.filter((value) => !value.startsWith("neuralflow-focus:")).map((value) => <span key={value} className="text-xs text-muted-foreground">#{value}</span>)}</div></li>)}</ul> : <Empty title="No notes match" description="Clear the filters or create a note. Notes are not created just by opening a task." action={<NewNote label="Create your first note" />} />}</Panel>
  </Screen>;
}

function ProjectDialog({ project }: { project?: Project }) {
  const { state, addProject, updateProject, notify } = useWorkspace();
  const [open, setOpen] = useState(false); const [error, setError] = useState(""); const [original, setOriginal] = useState(project);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const title = String(data.get("title") || "").trim(); if (!title) return;
    if (original && JSON.stringify(state.projects.find((item) => item.id === original.id)) !== JSON.stringify(original)) { setError("Project changed while you were editing. Close and reopen to load it again."); return; }
    const payload = { title, description: String(data.get("description") || ""), status: String(data.get("status")) };
    if (project) { if (!updateProject(project.id, payload).ok) return; } else if (!addProject(payload)) return;
    setOpen(false); notify("Project saved locally in the canonical workspace.");
  }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) { setOriginal(project); setError(""); } }}><DialogTrigger asChild><Button variant={project ? "outline" : "default"}>{project ? "Edit project" : "New project"}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{project ? "Edit project" : "Create a project"}</DialogTitle><DialogDescription>Projects are shared outcomes, not containers that own duplicate tasks.</DialogDescription></DialogHeader>{open && <form onSubmit={save} className="space-y-4"><Field label="Project title"><Input name="title" required defaultValue={project?.title} /></Field><Field label="Desired outcome"><Textarea name="description" rows={4} defaultValue={project?.description} /></Field><Field label="Status"><Select name="status" defaultValue={project?.status || "Active"}>{["Active", "Paused", "Completed", "Archived"].map((value) => <option key={value}>{value}</option>)}</Select></Field>{error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}<Button type="submit">Save project locally</Button></form>}</DialogContent></Dialog>;
}

function ProjectInspector({ project }: { project: Project }) {
  const { state } = useWorkspace(); const tasks = state.tasks.filter((task) => task.projectId === project.id); const notes = state.artifacts.filter((artifact) => artifact.kind === "note" && artifact.links.includes(project.id));
  return <Sheet><SheetTrigger asChild><Button variant="outline">Inspect project</Button></SheetTrigger><SheetContent className="w-full overflow-y-auto p-4 sm:max-w-xl"><SheetHeader className="px-0 pr-8"><SheetTitle>{project.title}</SheetTitle><SheetDescription>{project.description}</SheetDescription></SheetHeader><div className="flex gap-2"><ProjectDialog project={project} /><NewNote link={project.id} label="Add linked note" /></div><h3 className="mt-4 text-[13px] font-medium">Linked tasks</h3>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} task={task} />) : <Empty title="No linked tasks" description="Assign a canonical task to this project from its task inspector." />}<h3 className="mt-6 text-[13px] font-medium">Linked notes</h3>{notes.map((note) => <NoteInspector key={note.id} note={note} />)}{!notes.length && <p className="text-xs text-muted-foreground">No project notes yet.</p>}</SheetContent></Sheet>;
}

export function ProjectsScreen() {
  const { state } = useWorkspace(); const [search, setSearch] = useState(""); const [status, setStatus] = useState("Active");
  const projects = state.projects.filter((project) => `${project.title} ${project.description}`.toLowerCase().includes(search.toLowerCase()) && (status === "all" || project.status === status));
  return <Screen title="Projects" description="Name the outcome, then connect canonical work and learning. The same projects and assignments appear in the other product lenses." actions={<><NewTask /><ProjectDialog /></>}>
    <div className="flex flex-wrap items-end gap-4"><SearchField value={search} onChange={setSearch} placeholder="Search projects" /><Field label="Project status"><Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{["Active", "Paused", "Completed", "Archived"].map((value) => <option key={value}>{value}</option>)}</Select></Field></div>
    {projects.length ? <div className="grid gap-4 lg:grid-cols-2">{projects.map((project) => { const tasks = state.tasks.filter((task) => task.projectId === project.id); const done = tasks.filter((task) => task.status === "DONE").length; return <Panel key={project.id} title={project.title} description={project.description} actions={<Status>{project.status}</Status>}><div className="my-4 grid grid-cols-2 gap-3"><Stat label="Linked tasks" value={tasks.length} /><Stat label="Tasks done" value={done} /></div><progress value={done} max={tasks.length || 1} aria-label={`${project.title} task completion`} className="mb-4 h-2 w-full accent-primary" /><div className="flex flex-wrap gap-2"><ProjectInspector project={project} /><ProjectDialog project={project} /><Button variant="ghost" asChild><Link href="/apps/neuralflow/tasks">Assign tasks in inspector</Link></Button></div></Panel>; })}</div> : <Empty title="No matching projects" description="Adjust the filters or create an outcome to organize your work." action={<ProjectDialog />} />}
  </Screen>;
}
