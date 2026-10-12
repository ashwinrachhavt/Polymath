"use client";

import Link from "next/link";
import { useState, type ReactNode, type FormEvent } from "react";
import { Plus, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Empty, Field, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Task, TaskAttachment, TaskStatus } from "@/components/workspace/types";
import { localDate, statusLabels, taskStatuses } from "./planning";
import { recurrenceForPreset, presetForRecurrence, recurrencePresets } from "@/components/workspace/slash-commands";
import { ImportDrop, ImportedFileState } from "@/components/workspace/import-drop";
import { recurrenceLabel } from "@/components/workspace/tasks";

export const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function TaskForm({ task, defaultStatus = "INBOX", onSaved }: { task?: Task; defaultStatus?: TaskStatus; onSaved: () => void }) {
  const { state, addTask, updateTask } = useWorkspace();
  const [error, setError] = useState("");
  const [baselineVersion] = useState(task?.version);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") || "").trim();
    if (!title) { setError("Enter a task title."); return; }
    if (task && state.tasks.find((item) => item.id === task.id)?.version !== baselineVersion) { setError("This task changed while you were editing. Close and reopen the inspector to load its latest version."); return; }
    const recurrence = recurrenceForPreset(String(data.get("recurrence") || "none"));
    const typedDue = String(data.get("due") || "") || undefined;
    // A repeat rule with no date has nothing to advance, so it starts today
    // rather than silently doing nothing on completion.
    const dueDate = recurrence && !typedDue ? localDate() : typedDue;
    const patch = {
      status: String(data.get("status")) as TaskStatus,
      priority: String(data.get("priority")) as Task["priority"],
      projectId: String(data.get("project") || "") || undefined,
      dueDate,
      estimate: Number(data.get("estimate")),
      description: String(data.get("description") || ""),
      tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      recurrence,
    };
    if (task) updateTask(task.id, { title, ...patch });
    else addTask(title, patch);
    onSaved();
  }
  return <form onSubmit={save} className="space-y-4">
    <Field label="Title"><Input name="title" required maxLength={300} defaultValue={task?.title} autoFocus /></Field>
    <Field label="Description"><Textarea name="description" defaultValue={task?.description} rows={4} /></Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Status"><select name="status" className={selectClass} defaultValue={task?.status || defaultStatus}>{taskStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></Field>
      <Field label="Priority"><select name="priority" className={selectClass} defaultValue={task?.priority || "Medium"}>{["High", "Medium", "Low"].map((priority) => <option key={priority}>{priority}</option>)}</select></Field>
      <Field label="Due date"><Input type="date" name="due" defaultValue={task?.dueDate} /></Field>
      <Field label="Estimate (minutes)"><Input type="number" name="estimate" min={0} max={1440} required defaultValue={task?.estimate ?? 25} /></Field>
      <Field label="Repeats"><select name="recurrence" className={selectClass} defaultValue={presetForRecurrence(task?.recurrence)}>{recurrencePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></Field>
    </div>
    {task?.recurrence && <p className="text-xs text-muted-foreground">Completing this task moves it to its next date instead of closing it. {recurrenceLabel(task.recurrence)}.</p>}
    <Field label="Project"><select name="project" className={selectClass} defaultValue={task?.projectId || ""}><option value="">No project</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field>
    <Field label="Tags (comma-separated)"><Input name="tags" defaultValue={task?.tags.join(", ")} /></Field>
    {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onSaved}>Cancel</Button><Button type="submit">{task ? "Save task locally" : "Create task locally"}</Button></div>
  </form>;
}

export function NewTask({ status = "INBOX", label = "New task" }: { status?: TaskStatus; label?: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus aria-hidden className="size-4" />{label}</Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>New task</DialogTitle><DialogDescription>Create one canonical task in this browser preview. A board is not required.</DialogDescription></DialogHeader>{open && <TaskForm defaultStatus={status} onSaved={() => setOpen(false)} />}</DialogContent></Dialog>;
}

function Attachments({ task }: { task: Task }) {
  const { addAttachment, removeAttachment, notify } = useWorkspace();
  const attached = task.attachments || [];
  function accept(result: { kind: TaskAttachment["kind"]; label: string; value: string; size?: number }) {
    if (result.kind === "file" && !result.value) { notify(`${result.label}. Files are limited to 1 MB in this preview.`); return; }
    addAttachment(task.id, { kind: result.kind, label: result.label, value: result.value, size: result.size });
  }
  return <div className="mt-6 space-y-3"><h3 className="text-[13px] font-medium">Attachments</h3>
    {attached.length ? attached.map((item) => <ImportedFileState key={item.id} name={item.label} size={item.size} onRemove={() => removeAttachment(task.id, item.id)} />) : <Empty title="No attachments" description="Attach a link, a file or a pasted note. Nothing is uploaded in this preview." />}
    <ImportDrop onImport={accept} hint="Drop a file here, or paste a URL or some text. Files stay in this browser at up to 1 MB." accept={undefined} />
  </div>;
}

function InspectorContent({ task, close }: { task: Task; close: () => void }) {
  const { state } = useWorkspace();
  const notes = state.artifacts.filter((artifact) => artifact.kind === "note" && artifact.links.includes(task.id));
  return <><TaskForm task={task} onSaved={close} /><Attachments task={task} /><div className="mt-6 space-y-3"><h3 className="text-[13px] font-medium">Linked canonical notes</h3>{notes.length ? notes.map((note) => <Link key={note.id} href={`/apps/neuralflow/notes?note=${note.id}`} className="block text-[13px] underline underline-offset-4">{note.title}</Link>) : <Empty title="No linked notes" description="Create a note in Notes and link it to this task. Opening this inspector does not create an empty note." />}<Button variant="outline" asChild><Link href={`/apps/neuralflow/focus?task=${task.id}`}><Timer aria-hidden className="size-4" />Focus on this task</Link></Button><Unavailable feature="Task AI assistance">Enrichment, breakdown, and summaries require a supervised Alfred run. No generated content or task updates are simulated.</Unavailable></div></>;
}

export function TaskInspector({ task, children }: { task: Task; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild>{children}</SheetTrigger><SheetContent className="w-full overflow-y-auto p-4 sm:max-w-lg"><SheetHeader className="px-0 pr-8"><SheetTitle>Task inspector</SheetTitle><SheetDescription>Canonical task, revision {task.version}. Changes stay in this browser.</SheetDescription></SheetHeader>{open && <InspectorContent task={task} close={() => setOpen(false)} />}</SheetContent></Sheet>;
}

export function SelectedTask({ id }: { id: string }) {
  const { state } = useWorkspace();
  const task = state.tasks.find((item) => item.id === id);
  return task ? <TaskInspector task={task}><Button variant="outline">Inspect {task.title}</Button></TaskInspector> : <Empty title="Task not found in this preview" description="This link may refer to a record from another browser or a reset workspace." />;
}

export function TaskRow({ task }: { task: Task }) {
  const { state, updateTask, completeTask, notify } = useWorkspace();
  const project = state.projects.find((item) => item.id === task.projectId);
  function toggleDone() {
    if (task.status === "DONE") { updateTask(task.id, { status: "READY", completedAt: undefined }); notify("Task reopened locally."); return; }
    completeTask(task.id);
    notify(task.recurrence ? "Task completed locally and moved to its next date." : "Task marked done locally. Reopen with its checkbox; task completion does not grant focus rewards.");
  }
  return <div className="flex items-start gap-3 border-b border-border py-3 last:border-0">
    <input type="checkbox" checked={task.status === "DONE"} onChange={toggleDone} aria-label={`${task.status === "DONE" ? "Reopen" : "Complete"} ${task.title}`} className="mt-1 size-5 accent-primary" />
    <div className="min-w-0 flex-1"><TaskInspector task={task}><button type="button" className={`text-left text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-ring ${task.status === "DONE" ? "text-muted-foreground line-through" : ""}`}>{task.title}</button></TaskInspector><div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Status>{statusLabels[task.status]}</Status><span>{task.priority} priority</span><span className="readout">{task.estimate} min</span>{task.dueDate && <span>Due {task.dueDate}</span>}{project && <span>{project.title}</span>}{task.recurrence && <span>{recurrenceLabel(task.recurrence)}</span>}{task.attachments?.length ? <span>{task.attachments.length} attached</span> : null}{task.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div></div>
  </div>;
}
